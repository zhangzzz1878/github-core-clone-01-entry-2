// store.ts — in-memory forge state: repositories, git objects, issues,
// pull requests, labels, comments. Deterministic by construction: ids are
// sequential counters and server-made timestamps come from a fixed epoch
// plus a counter, so nothing here depends on wall-clock time, ports, or
// randomness.

import {
  ZERO_OID,
  hashObject,
  parseCommit,
  parseTree,
  buildCommit,
  buildTreeFromMap,
  flattenTree,
  isAncestor,
  mergeBase,
  diffFlatMaps,
  lineDiffCounts,
} from './gitobjs.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

// Deterministic clocks. Server-created commits use COMMIT_EPOCH + counter
// as their unix timestamp; API timestamps use ISO_EPOCH + counter seconds.
const COMMIT_EPOCH = 1700000000;
const ISO_EPOCH = 1735689600; // 2025-01-01T00:00:00Z
let seq = 0;
export function nextSeq() {
  return ++seq;
}
export function nextCommitTs() {
  return COMMIT_EPOCH + nextSeq();
}
export function nextIso() {
  return new Date((ISO_EPOCH + nextSeq()) * 1000).toISOString();
}

let nextRepoId = 1;
let nextObjectId = 1; // shared counter for issue/PR/comment REST ids

export function viewerUserJson() {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', name: VIEWER_NAME, email: VIEWER_EMAIL };
}

export class Repo {
  constructor(name, opts = {}) {
    this.id = nextRepoId++;
    this.name = name;
    this.owner = VIEWER_LOGIN;
    this.description = typeof opts.description === 'string' ? opts.description : '';
    this.private = !!opts.private;
    this.defaultBranch = 'main';
    this.createdAt = nextIso();
    this.updatedAt = this.createdAt;
    this.refs = new Map(); // full ref name -> oid
    this.objects = new Map(); // oid -> { type, data }
    this.commitCache = new Map(); // oid -> parsed commit
    this.flatCache = new Map(); // commit oid -> flattened tree Map
    this.deflateCache = new Map(); // oid -> encoded pack entry bytes
    this.packCache = new Map(); // fetch key -> { pack, shallowOut, unshallowOut }
    this.labels = new Map(); // name -> { name, color }
    this.issues = new Map(); // number -> issue
    this.pulls = new Map(); // number -> pr
    this.nextNumber = 1;
    this.issueJsonCache = new Map(); // number -> serialized issue JSON string
    this.prJsonCache = new Map();
  }

  get fullName() {
    return `${this.owner}/${this.name}`;
  }

  mutate() {
    // Any object/ref change invalidates fetch-pack caches (not the
    // per-object deflate cache: object bytes are immutable).
    this.packCache.clear();
  }

  // ------------------------------------------------------------ git state

  getObject(oid) {
    return this.objects.get(oid) ?? null;
  }

  putObject(type, data) {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getCommit(oid) {
    if (!oid || oid === ZERO_OID) return null;
    if (this.commitCache.has(oid)) return this.commitCache.get(oid);
    const obj = this.objects.get(oid);
    if (!obj || obj.type !== 'commit') return null;
    const parsed = parseCommit(obj.data);
    this.commitCache.set(oid, parsed);
    return parsed;
  }

  getTreeEntries(oid) {
    const obj = this.objects.get(oid);
    if (!obj || obj.type !== 'tree') return null;
    return parseTree(obj.data);
  }

  branchTip(branch) {
    return this.refs.get(`refs/heads/${branch}`) ?? null;
  }

  defaultTip() {
    return this.branchTip(this.defaultBranch);
  }

  setRef(ref, oid) {
    this.refs.set(ref, oid);
    this.mutate();
  }

  deleteRef(ref) {
    this.refs.delete(ref);
    this.mutate();
  }

  flattenCommit(commitOid) {
    if (this.flatCache.has(commitOid)) return this.flatCache.get(commitOid);
    const commit = this.getCommit(commitOid);
    const flat = commit ? flattenTree(this.objects, commit.tree) : new Map();
    this.flatCache.set(commitOid, flat);
    return flat;
  }

  // Create a commit object (not yet attached to any ref) and return its oid.
  createCommit({ tree, parents, message }) {
    const data = buildCommit({
      tree,
      parents,
      message,
      authorName: VIEWER_NAME,
      authorEmail: VIEWER_EMAIL,
      ts: nextCommitTs(),
    });
    const oid = this.putObject('commit', data);
    this.mutate();
    return oid;
  }

  // Resolve a ref-ish (branch name, full ref, or 40-hex oid) to a commit oid.
  resolveRef(refish) {
    if (!refish) return this.defaultTip();
    if (this.refs.has(refish)) return this.refs.get(refish);
    const asBranch = this.branchTip(refish);
    if (asBranch) return asBranch;
    if (this.objects.has(refish)) {
      const obj = this.objects.get(refish);
      if (obj.type === 'commit') return refish;
    }
    return null;
  }

  // Walk history from `tip` (newest first, all parents, deduped).
  walkCommits(tip, limit = 100) {
    const out = [];
    const seen = new Set();
    const stack = tip ? [tip] : [];
    while (stack.length > 0 && out.length < limit) {
      const oid = stack.pop();
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = this.getCommit(oid);
      if (!commit) continue;
      out.push({ oid, commit });
      for (let i = commit.parents.length - 1; i >= 0; i--) stack.push(commit.parents[i]);
    }
    return out;
  }

  // ------------------------------------------------------------- contents

  // Commit a file change on `branch` (creating the branch from the default
  // tip, or from empty, when it does not exist yet). `change` is either
  // { path, content: Buffer } or { path, remove: true }. Returns
  // { commitOid, blobOid } (blobOid null when removing).
  commitFileChange(branch, message, change) {
    let baseTip = this.branchTip(branch);
    if (!baseTip) {
      baseTip = this.defaultTip();
      // New branch: starts at the default tip (or unborn).
    }
    const flat = baseTip ? new Map(this.flattenCommit(baseTip)) : new Map();
    let blobOid = null;
    if (change.remove) {
      flat.delete(change.path);
    } else {
      blobOid = this.putObject('blob', change.content);
      flat.set(change.path, { oid: blobOid, mode: '100644' });
    }
    const treeOid = buildTreeFromMap(this.objects, flat);
    const parents = baseTip ? [baseTip] : [];
    const commitOid = this.createCommit({ tree: treeOid, parents, message });
    this.setRef(`refs/heads/${branch}`, commitOid);
    return { commitOid, blobOid };
  }

  // --------------------------------------------------------------- labels

  ensureLabel(name, color) {
    if (this.labels.has(name)) return this.labels.get(name);
    const label = { name, color: typeof color === 'string' && color ? color : 'ededed' };
    this.labels.set(name, label);
    return label;
  }

  // --------------------------------------------------------------- issues

  createIssue({ title, body = '', labelNames = [] }) {
    const number = this.nextNumber++;
    const now = nextIso();
    const issue = {
      id: nextObjectId++,
      number,
      title,
      body,
      state: 'open',
      labels: labelNames.map((n) => this.labels.get(n)),
      comments: [],
      createdAt: now,
      updatedAt: now,
      createdSeq: nextSeq(),
    };
    this.issues.set(number, issue);
    this.issueJsonCache.delete(number);
    return issue;
  }

  listIssues({ state = 'open', sort = 'created', direction = 'desc' } = {}) {
    let list = [...this.issues.values()];
    if (state !== 'all') list = list.filter((i) => i.state === state);
    list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
    return list;
  }

  patchIssue(number, patch) {
    const issue = this.issues.get(number);
    if (!issue) return null;
    if (typeof patch.title === 'string') issue.title = patch.title;
    if (typeof patch.body === 'string') issue.body = patch.body;
    if (patch.state === 'open' || patch.state === 'closed') issue.state = patch.state;
    if (Array.isArray(patch.labels)) {
      issue.labels = patch.labels
        .map((l) => (typeof l === 'string' ? this.labels.get(l) : this.labels.get(l?.name)))
        .filter(Boolean);
    }
    issue.updatedAt = nextIso();
    this.issueJsonCache.delete(number);
    return issue;
  }

  addComment(number, body) {
    const issue = this.issues.get(number);
    if (!issue) return null;
    const comment = {
      id: nextObjectId++,
      body,
      user: viewerUserJson(),
      createdAt: nextIso(),
      updatedAt: null,
    };
    comment.updatedAt = comment.createdAt;
    issue.comments.push(comment);
    this.issueJsonCache.delete(number);
    return comment;
  }

  // ----------------------------------------------------------------- pulls

  createPull({ title, body = '', headRef, baseRef }) {
    const headSha = this.branchTip(headRef);
    const baseSha = this.branchTip(baseRef);
    const number = this.nextNumber++;
    const now = nextIso();
    const pr = {
      id: nextObjectId++,
      number,
      title,
      body,
      state: 'open',
      merged: false,
      headRef,
      baseRef,
      headSha,
      baseSha,
      mergeCommitSha: null,
      mergedAt: null,
      createdAt: now,
      updatedAt: now,
      createdSeq: nextSeq(),
    };
    this.pulls.set(number, pr);
    this.prJsonCache.delete(number);
    return pr;
  }

  listPulls({ state = 'open' } = {}) {
    let list = [...this.pulls.values()];
    if (state !== 'all') list = list.filter((p) => p.state === state);
    list.sort((a, b) => b.number - a.number);
    return list;
  }

  // File-level three-way merge analysis for a pull request.
  // Returns { conflict: bool, mergedFlat: Map|null, baseOid, headOid, mergeBaseOid }.
  analyzeMerge(pr) {
    const baseOid = this.branchTip(pr.baseRef) ?? pr.baseSha;
    const headOid = this.branchTip(pr.headRef) ?? pr.headSha;
    const mb = mergeBase(this.objects, baseOid, headOid);
    const baseFlat = mb ? this.flattenCommit(mb) : new Map();
    const oursFlat = baseOid ? this.flattenCommit(baseOid) : new Map();
    const theirsFlat = headOid ? this.flattenCommit(headOid) : new Map();
    const mergedFlat = new Map(oursFlat);
    let conflict = false;
    const paths = new Set([...baseFlat.keys(), ...theirsFlat.keys(), ...oursFlat.keys()]);
    for (const path of paths) {
      const b = baseFlat.get(path);
      const o = oursFlat.get(path);
      const t = theirsFlat.get(path);
      const tChanged = (t?.oid ?? null) !== (b?.oid ?? null);
      const oChanged = (o?.oid ?? null) !== (b?.oid ?? null);
      if (!tChanged) continue; // theirs unchanged: keep ours
      if (!oChanged) {
        // Only theirs changed: take theirs (or remove if theirs deleted).
        if (t) mergedFlat.set(path, t);
        else mergedFlat.delete(path);
        continue;
      }
      // Both changed: same result is fine, different results conflict.
      if ((t?.oid ?? null) === (o?.oid ?? null)) continue;
      conflict = true;
    }
    return { conflict, mergedFlat: conflict ? null : mergedFlat, baseOid, headOid, mergeBaseOid: mb };
  }

  // Squash-merge a pull request onto its base branch. Returns
  // { ok: true, sha } or { ok: false, reason: 'conflict' }.
  mergePull(pr) {
    if (pr.merged) return { ok: true, sha: pr.mergeCommitSha };
    const { conflict, mergedFlat, baseOid } = this.analyzeMerge(pr);
    if (conflict) return { ok: false, reason: 'conflict' };
    const treeOid = buildTreeFromMap(this.objects, mergedFlat);
    const message = `Merge pull request #${pr.number} from ${pr.headRef}`;
    const parents = baseOid ? [baseOid] : [];
    const sha = this.createCommit({ tree: treeOid, parents, message });
    this.setRef(`refs/heads/${pr.baseRef}`, sha);
    pr.merged = true;
    pr.state = 'closed';
    pr.mergeCommitSha = sha;
    pr.mergedAt = nextIso();
    pr.updatedAt = pr.mergedAt;
    this.prJsonCache.delete(pr.number);
    return { ok: true, sha };
  }

  // Diff files for a pull request (merge-base tree vs head tree).
  pullFiles(pr) {
    const baseOid = this.branchTip(pr.baseRef) ?? pr.baseSha;
    const headOid = this.branchTip(pr.headRef) ?? pr.headSha;
    const mb = mergeBase(this.objects, baseOid, headOid);
    const baseFlat = mb ? this.flattenCommit(mb) : new Map();
    const headFlat = headOid ? this.flattenCommit(headOid) : new Map();
    const diffs = diffFlatMaps(baseFlat, headFlat);
    return diffs.map((d) => {
      const oldBuf = d.oldOid ? this.objects.get(d.oldOid)?.data ?? null : null;
      const newBuf = d.newOid ? this.objects.get(d.newOid)?.data ?? null : null;
      const { additions, deletions } = lineDiffCounts(oldBuf, newBuf);
      return {
        filename: d.path,
        status: d.status,
        additions,
        deletions,
        changes: additions + deletions,
      };
    });
  }
}

// ------------------------------------------------------------ global registry

const reposByKey = new Map(); // 'owner/name' -> Repo
const reposById = new Map(); // databaseId -> Repo

export function getRepo(owner, name) {
  if (owner !== VIEWER_LOGIN) return null;
  return reposByKey.get(`${owner}/${name}`) ?? null;
}

export function getRepoById(id) {
  return reposById.get(id) ?? null;
}

export function createRepo(name, opts = {}) {
  if (reposByKey.has(`${VIEWER_LOGIN}/${name}`)) return null;
  const repo = new Repo(name, opts);
  reposByKey.set(repo.fullName, repo);
  reposById.set(repo.id, repo);
  return repo;
}

export function deleteRepo(owner, name) {
  const repo = getRepo(owner, name);
  if (!repo) return false;
  reposByKey.delete(repo.fullName);
  reposById.delete(repo.id);
  return true;
}

export function listRepos() {
  return [...reposByKey.values()].sort((a, b) => a.id - b.id);
}

// -------------------------------------------------------------- serializers

export function repoJson(repo) {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    html_url: `https://github.com/${repo.fullName}`,
    url: `/api/v3/repos/${repo.fullName}`,
    clone_url: `https://github.com/${repo.fullName}.git`,
    git_url: `git://github.com/${repo.fullName}.git`,
    ssh_url: `git@github.com:${repo.fullName}.git`,
  };
}

export function labelJson(label) {
  return { name: label.name, color: label.color };
}

export function issueJson(repo, issue) {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: viewerUserJson(),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: issue.comments.length,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
  };
}

export function commentJson(repo, issue, comment) {
  return {
    id: comment.id,
    body: comment.body,
    user: comment.user,
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}/comments/${comment.id}`,
  };
}

export function prJson(repo, pr) {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merge_commit_sha: pr.mergeCommitSha,
    merged_at: pr.mergedAt,
    head: {
      ref: pr.headRef,
      sha: pr.headSha,
      label: `${repo.owner}:${pr.headRef}`,
      user: viewerUserJson(),
      repo: repoJson(repo),
    },
    base: {
      ref: pr.baseRef,
      sha: pr.baseSha,
      label: `${repo.owner}:${pr.baseRef}`,
      user: viewerUserJson(),
      repo: repoJson(repo),
    },
    user: viewerUserJson(),
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    html_url: `https://github.com/${repo.fullName}/pull/${pr.number}`,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pr.number}`,
  };
}

export function commitJson(repo, oid, commit) {
  const message = commit.message.replace(/\n+$/, '');
  const ident = (line) => {
    const m = line.match(/^(.*) <(.*)> (\d+) ([+-]\d{4})$/);
    if (!m) return { name: '', email: '', date: '' };
    return {
      name: m[1],
      email: m[2],
      date: new Date(Number(m[3]) * 1000).toISOString(),
    };
  };
  return {
    sha: oid,
    commit: {
      message,
      author: ident(commit.author),
      committer: ident(commit.committer),
      tree: { sha: commit.tree },
    },
    parents: commit.parents.map((p) => ({ sha: p })),
    author: { login: repo.owner, id: VIEWER_ID },
    committer: { login: repo.owner, id: VIEWER_ID },
  };
}

export { isAncestor, ZERO_OID };

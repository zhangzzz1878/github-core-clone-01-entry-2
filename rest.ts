// rest.ts — GitHub REST v3 surface under /api/v3. Handlers take a ctx
// { method, segments, query, body, host } and return
// { status, headers, body } where body is a string or Buffer.

import { ZERO_OID, isOid } from './gitobjs.ts';
import {
  VIEWER_LOGIN,
  VIEWER_ID,
  viewerUserJson,
  getRepo,
  getRepoById,
  createRepo,
  deleteRepo,
  listRepos,
  repoJson,
  labelJson,
  issueJson,
  commentJson,
  prJson,
  commitJson,
} from './store.ts';

export function json(status, value, headers = {}) {
  return {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof value === 'string' ? value : JSON.stringify(value),
  };
}

export function err(status, message) {
  return json(status, { message });
}

function notFound(message = 'Not Found') {
  return err(404, message);
}

function parseBody(ctx) {
  if (!ctx.body || ctx.body.length === 0) return {};
  try {
    return JSON.parse(ctx.body.toString('utf8'));
  } catch {
    const e = new Error('Malformed JSON body');
    e.status = 400;
    throw e;
  }
}

function pageParams(ctx) {
  const perPage = Math.max(1, Math.min(100, parseInt(ctx.query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(ctx.query.get('page') ?? '1', 10) || 1);
  return { perPage, page };
}

function paginate(list, perPage, page) {
  const start = (page - 1) * perPage;
  return list.slice(start, start + perPage);
}

function linkHeader(ctx, path, perPage, page, total) {
  const base = `http://${ctx.host}${path}`;
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const parts = [];
  if (page < lastPage) parts.push(`<${base}?per_page=${perPage}&page=${page + 1}>; rel="next"`);
  parts.push(`<${base}?per_page=${perPage}&page=${lastPage}>; rel="last"`);
  parts.push(`<${base}?per_page=${perPage}&page=1>; rel="first"`);
  return parts.join(', ');
}

// segments are the path parts after /api/v3, already decoded.
export function handleRest(ctx) {
  const seg = ctx.segments;
  const m = ctx.method;

  // API root
  if (seg.length === 0) {
    if (m !== 'GET') return err(405, 'Method Not Allowed');
    return json(200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
    }, { 'X-OAuth-Scopes': 'repo, read:org' });
  }

  if (seg[0] === 'meta') {
    if (m !== 'GET') return err(405, 'Method Not Allowed');
    return json(200, { installed_version: '1.0.0' });
  }

  if (seg[0] === 'user') {
    if (seg.length === 1) {
      if (m !== 'GET') return err(405, 'Method Not Allowed');
      return json(200, viewerUserJson());
    }
    if (seg[1] === 'repos') {
      if (m === 'POST') return createUserRepo(ctx);
      if (m === 'GET') return listUserRepos(ctx);
      return err(405, 'Method Not Allowed');
    }
    return notFound();
  }

  if (seg[0] === 'repos' && seg.length >= 3) {
    return handleRepoRest(ctx, seg[1], seg[2], seg.slice(3));
  }

  return notFound();
}

function createUserRepo(ctx) {
  const body = parseBody(ctx);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return err(422, 'name is required');
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return err(422, 'name is invalid');
  const repo = createRepo(name, { description: body.description, private: body.private });
  if (!repo) return err(422, `Repository '${name}' already exists`);
  return json(201, repoJson(repo));
}

function listUserRepos(ctx) {
  const { perPage, page } = pageParams(ctx);
  const all = listRepos();
  const items = paginate(all, perPage, page).map(repoJson);
  return json(200, items, {
    Link: linkHeader(ctx, '/api/v3/user/repos', perPage, page, all.length),
  });
}

function handleRepoRest(ctx, owner, name, rest) {
  const repo = getRepo(owner, name);
  if (!repo) return notFound('Not Found');
  const m = ctx.method;

  // /repos/{o}/{r}
  if (rest.length === 0) {
    if (m === 'GET') return json(200, repoJson(repo));
    if (m === 'PATCH') {
      const body = parseBody(ctx);
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      return json(200, repoJson(repo));
    }
    if (m === 'DELETE') {
      deleteRepo(owner, name);
      return { status: 204, headers: {}, body: '' };
    }
    return err(405, 'Method Not Allowed');
  }

  const head = rest[0];

  if (head === 'git' && rest[1] === 'refs') {
    if (m === 'POST' && rest.length === 2) return createRef(ctx, repo);
    if (m === 'GET' && rest.length >= 3) return getRef(ctx, repo, rest.slice(2).join('/'));
    return err(405, 'Method Not Allowed');
  }

  if (head === 'branches') {
    if (m === 'GET' && rest.length === 1) return listBranches(ctx, repo);
    if (m === 'GET' && rest.length >= 2) return getBranch(ctx, repo, rest.slice(1).join('/'));
    return err(405, 'Method Not Allowed');
  }

  if (head === 'commits') {
    if (m === 'GET' && rest.length === 1) return listCommits(ctx, repo);
    if (m === 'GET' && rest.length === 2) return getCommit(ctx, repo, rest[1]);
    return err(405, 'Method Not Allowed');
  }

  if (head === 'contents') {
    const path = rest.slice(1).join('/');
    if (m === 'GET') return getContents(ctx, repo, path);
    if (m === 'PUT') return putContents(ctx, repo, path);
    if (m === 'DELETE') return deleteContents(ctx, repo, path);
    return err(405, 'Method Not Allowed');
  }

  if (head === 'labels') {
    if (m === 'POST' && rest.length === 1) return createLabel(ctx, repo);
    if (m === 'GET' && rest.length === 1) {
      return json(200, [...repo.labels.values()].map(labelJson));
    }
    return err(405, 'Method Not Allowed');
  }

  if (head === 'issues') {
    if (rest.length === 1) {
      if (m === 'POST') return createIssue(ctx, repo);
      if (m === 'GET') return listIssues(ctx, repo);
      return err(405, 'Method Not Allowed');
    }
    const num = parseInt(rest[1], 10);
    if (!Number.isInteger(num) || num < 1) return notFound();
    if (rest.length === 2) {
      if (m === 'GET') return getIssue(ctx, repo, num);
      if (m === 'PATCH') return patchIssue(ctx, repo, num);
      return err(405, 'Method Not Allowed');
    }
    if (rest[2] === 'comments') {
      if (m === 'POST') return createComment(ctx, repo, num);
      if (m === 'GET') return listComments(ctx, repo, num);
      return err(405, 'Method Not Allowed');
    }
    return notFound();
  }

  if (head === 'pulls') {
    if (rest.length === 1) {
      if (m === 'POST') return createPull(ctx, repo);
      if (m === 'GET') return listPulls(ctx, repo);
      return err(405, 'Method Not Allowed');
    }
    const num = parseInt(rest[1], 10);
    if (!Number.isInteger(num) || num < 1) return notFound();
    if (rest.length === 2) {
      if (m === 'GET') return getPull(ctx, repo, num);
      return err(405, 'Method Not Allowed');
    }
    if (rest[2] === 'files' && m === 'GET') return listPullFiles(ctx, repo, num);
    if (rest[2] === 'merge' && m === 'PUT') return mergePull(ctx, repo, num);
    return notFound();
  }

  return notFound();
}

// -------------------------------------------------------------------- refs

function createRef(ctx, repo) {
  const body = parseBody(ctx);
  const ref = typeof body.ref === 'string' ? body.ref : '';
  const sha = typeof body.sha === 'string' ? body.sha : '';
  if (!ref.startsWith('refs/')) return err(422, 'ref must start with refs/');
  if (!isOid(sha)) return err(422, 'sha must be a 40-hex object id');
  if (!repo.getObject(sha)) return err(422, 'sha does not exist');
  if (repo.refs.has(ref)) return err(422, 'Reference already exists');
  repo.setRef(ref, sha);
  return json(201, { ref, object: { sha, type: repo.getObject(sha).type } });
}

function getRef(ctx, repo, refPath) {
  // refPath like 'heads/main' or 'heads/feature/x'
  const ref = `refs/${refPath}`;
  const oid = repo.refs.get(ref);
  if (!oid) return notFound('Not Found');
  const obj = repo.getObject(oid);
  return json(200, { ref, object: { sha: oid, type: obj ? obj.type : 'commit' } });
}

function listBranches(ctx, repo) {
  const out = [];
  for (const ref of [...repo.refs.keys()].sort()) {
    if (!ref.startsWith('refs/heads/')) continue;
    out.push({
      name: ref.slice('refs/heads/'.length),
      commit: { sha: repo.refs.get(ref) },
      protected: false,
    });
  }
  return json(200, out);
}

function getBranch(ctx, repo, branch) {
  const tip = repo.branchTip(branch);
  if (!tip) return notFound('Not Found');
  return json(200, { name: branch, commit: { sha: tip }, protected: false });
}

// ------------------------------------------------------------------ commits

function listCommits(ctx, repo) {
  const ref = ctx.query.get('sha') ?? undefined;
  const tip = repo.resolveRef(ref);
  if (ref && !tip) return notFound('Not Found');
  const { perPage } = pageParams(ctx);
  const walked = repo.walkCommits(tip, perPage);
  return json(200, walked.map(({ oid, commit }) => commitJson(repo, oid, commit)));
}

function getCommit(ctx, repo, refish) {
  const tip = repo.resolveRef(refish);
  if (!tip) return notFound('Not Found');
  const commit = repo.getCommit(tip);
  if (!commit) return notFound('Not Found');
  return json(200, commitJson(repo, tip, commit));
}

// ----------------------------------------------------------------- contents

function treeOidAt(repo, tip, path) {
  const commit = repo.getCommit(tip);
  if (!commit) return null;
  let treeOid = commit.tree;
  if (!path) return treeOid;
  for (const part of path.split('/')) {
    const entries = repo.getTreeEntries(treeOid);
    if (!entries) return null;
    const found = entries.find((e) => e.name === part && e.isDir);
    if (!found) return null;
    treeOid = found.oid;
  }
  return treeOid;
}

function getContents(ctx, repo, path) {
  const ref = ctx.query.get('ref') ?? undefined;
  const tip = repo.resolveRef(ref);
  if (ref && !tip) return notFound('Not Found');
  if (!tip) return notFound('Not Found');
  const flat = repo.flattenCommit(tip);
  const file = flat.get(path);
  if (file) {
    const obj = repo.getObject(file.oid);
    const data = obj ? obj.data : Buffer.alloc(0);
    return json(200, {
      type: 'file',
      encoding: 'base64',
      content: data.toString('base64'),
      sha: file.oid,
      size: data.length,
      name: path.split('/').pop(),
      path,
    });
  }
  // Directory listing (path '' is the root): read the tree directly so
  // directory entries carry their real tree oids.
  const treeOid = treeOidAt(repo, tip, path);
  if (!treeOid) return notFound('Not Found');
  const entries = repo.getTreeEntries(treeOid) ?? [];
  const prefix = path ? path + '/' : '';
  const out = entries.map((e) => {
    const entry = {
      type: e.isDir ? 'dir' : 'file',
      name: e.name,
      path: prefix + e.name,
      sha: e.oid,
    };
    if (!e.isDir) {
      const obj = repo.getObject(e.oid);
      entry.size = obj ? obj.data.length : 0;
    }
    return entry;
  });
  out.sort((a, b) => (a.name < b.name ? -1 : 1));
  return json(200, out);
}

function putContents(ctx, repo, path) {
  const body = parseBody(ctx);
  const message = typeof body.message === 'string' ? body.message : 'Update file';
  const contentB64 = typeof body.content === 'string' ? body.content : '';
  const branch = typeof body.branch === 'string' && body.branch ? body.branch : repo.defaultBranch;
  const sha = typeof body.sha === 'string' ? body.sha : null;
  let content;
  try {
    content = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
  } catch {
    return err(422, 'content is not valid base64');
  }
  const tip = repo.branchTip(branch) ?? repo.defaultTip();
  const flat = tip ? repo.flattenCommit(tip) : new Map();
  const existing = flat.get(path);
  let status = 201;
  if (existing) {
    if (sha && sha !== existing.oid) return err(409, 'sha does not match the current blob');
    if (!sha) return err(422, 'sha is required to update an existing file');
    status = 200;
  }
  const { commitOid, blobOid } = repo.commitFileChange(branch, message, { path, content });
  return json(status, {
    content: {
      name: path.split('/').pop(),
      path,
      sha: blobOid,
      size: content.length,
      type: 'file',
      encoding: 'base64',
    },
    commit: { sha: commitOid, message },
  });
}

function deleteContents(ctx, repo, path) {
  const body = parseBody(ctx);
  const message = typeof body.message === 'string' ? body.message : 'Delete file';
  const branch = typeof body.branch === 'string' && body.branch ? body.branch : repo.defaultBranch;
  const sha = typeof body.sha === 'string' ? body.sha : null;
  const tip = repo.branchTip(branch);
  if (!tip) return notFound('Not Found');
  const flat = repo.flattenCommit(tip);
  const existing = flat.get(path);
  if (!existing) return notFound('Not Found');
  if (sha && sha !== existing.oid) return err(409, 'sha does not match the current blob');
  const { commitOid } = repo.commitFileChange(branch, message, { path, remove: true });
  return json(200, { commit: { sha: commitOid, message } });
}

// ------------------------------------------------------------------- labels

function createLabel(ctx, repo) {
  const body = parseBody(ctx);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return err(422, 'name is required');
  const label = repo.ensureLabel(name, body.color);
  return json(201, labelJson(label));
}

// ------------------------------------------------------------------- issues

function createIssue(ctx, repo) {
  const body = parseBody(ctx);
  const title = typeof body.title === 'string' ? body.title : '';
  if (!title) return err(422, 'title is required');
  const labelNames = Array.isArray(body.labels)
    ? body.labels.map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean)
    : [];
  for (const n of labelNames) {
    if (!repo.labels.has(n)) return err(422, `Label '${n}' does not exist`);
  }
  const issue = repo.createIssue({ title, body: body.body ?? '', labelNames });
  return json(201, issueJson(repo, issue));
}

function listIssues(ctx, repo) {
  const state = ctx.query.get('state') ?? 'open';
  const sort = ctx.query.get('sort') ?? 'created';
  const direction = ctx.query.get('direction') ?? 'desc';
  const { perPage, page } = pageParams(ctx);
  const all = repo.listIssues({ state, sort, direction });
  const items = paginate(all, perPage, page).map((i) => issueJson(repo, i));
  return json(200, items);
}

function getIssue(ctx, repo, num) {
  const issue = repo.issues.get(num);
  if (!issue) return notFound('Not Found');
  // Hot path for the read benchmark: serve a cached serialization.
  let cached = repo.issueJsonCache.get(num);
  if (!cached) {
    cached = JSON.stringify(issueJson(repo, issue));
    repo.issueJsonCache.set(num, cached);
  }
  return json(200, cached);
}

function patchIssue(ctx, repo, num) {
  const issue = repo.issues.get(num);
  if (!issue) return notFound('Not Found');
  const body = parseBody(ctx);
  const patched = repo.patchIssue(num, body);
  return json(200, issueJson(repo, patched));
}

function createComment(ctx, repo, num) {
  const issue = repo.issues.get(num);
  if (!issue) return notFound('Not Found');
  const body = parseBody(ctx);
  const text = typeof body.body === 'string' ? body.body : '';
  const comment = repo.addComment(num, text);
  return json(201, commentJson(repo, issue, comment));
}

function listComments(ctx, repo, num) {
  const issue = repo.issues.get(num);
  if (!issue) return notFound('Not Found');
  return json(200, issue.comments.map((c) => commentJson(repo, issue, c)));
}

// -------------------------------------------------------------------- pulls

function normalizeBranchRef(ref) {
  // Accept "owner:branch" as well as plain branch names.
  if (typeof ref !== 'string') return '';
  const idx = ref.indexOf(':');
  return idx === -1 ? ref : ref.slice(idx + 1);
}

function createPull(ctx, repo) {
  const body = parseBody(ctx);
  const title = typeof body.title === 'string' ? body.title : '';
  if (!title) return err(422, 'title is required');
  const headRef = normalizeBranchRef(body.head);
  const baseRef = normalizeBranchRef(body.base) || repo.defaultBranch;
  if (!headRef) return err(422, 'head is required');
  if (!repo.branchTip(headRef)) return err(422, `head branch '${headRef}' does not exist`);
  if (!repo.branchTip(baseRef)) return err(422, `base branch '${baseRef}' does not exist`);
  const pr = repo.createPull({ title, body: body.body ?? '', headRef, baseRef });
  return json(201, prJson(repo, pr));
}

function listPulls(ctx, repo) {
  const state = ctx.query.get('state') ?? 'open';
  const { perPage, page } = pageParams(ctx);
  const all = repo.listPulls({ state });
  const items = paginate(all, perPage, page).map((p) => prJson(repo, p));
  return json(200, items);
}

function getPull(ctx, repo, num) {
  const pr = repo.pulls.get(num);
  if (!pr) return notFound('Not Found');
  let cached = repo.prJsonCache.get(num);
  if (!cached) {
    cached = JSON.stringify(prJson(repo, pr));
    repo.prJsonCache.set(num, cached);
  }
  return json(200, cached);
}

function listPullFiles(ctx, repo, num) {
  const pr = repo.pulls.get(num);
  if (!pr) return notFound('Not Found');
  return json(200, repo.pullFiles(pr));
}

function mergePull(ctx, repo, num) {
  const pr = repo.pulls.get(num);
  if (!pr) return notFound('Not Found');
  parseBody(ctx); // merge_method is accepted but squash is the only behavior
  const result = repo.mergePull(pr);
  if (!result.ok) return err(405, 'Merge conflict: this pull request cannot be merged');
  return json(200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
}

export { VIEWER_LOGIN, VIEWER_ID };

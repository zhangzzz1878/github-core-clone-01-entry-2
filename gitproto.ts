// gitproto.ts — git smart HTTP: v0/v2 advertisement, ls-refs, fetch and
// receive-pack. Speaks pkt-lines and packfiles directly; no git binary.

import {
  ZERO_OID,
  isOid,
  parseTree,
  parseTag,
  peelToCommit,
  flattenTree,
  isAncestor,
  readPack,
  writePack,
} from './gitobjs.ts';
import { VIEWER_LOGIN, getRepo } from './store.ts';

// ---------------------------------------------------------------- pkt-lines

export function pktLine(content) {
  // content is a string (without length prefix) or Buffer.
  const body = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const len = body.length + 4;
  const header = len.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(header, 'ascii'), body]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

// Parse a pkt-line stream into [{ kind: 'data'|'flush'|'delim', text, raw }].
// `text` is the payload as a string (data packets only). Throws on malformed
// input. Returns { packets, rest } where rest is the unconsumed tail
// (receive-pack's pack bytes follow the final flush).
export function parsePktLines(buf) {
  const packets = [];
  let pos = 0;
  while (pos < buf.length) {
    if (pos + 4 > buf.length) throw new Error('truncated pkt-line header');
    const hex = buf.toString('ascii', pos, pos + 4);
    if (hex === '0000') {
      packets.push({ kind: 'flush' });
      pos += 4;
      break; // rest (if any) is payload, e.g. a pack
    }
    if (hex === '0001') {
      packets.push({ kind: 'delim' });
      pos += 4;
      continue;
    }
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('bad pkt-line length');
    const len = parseInt(hex, 16);
    if (len < 4 || len > 65520) throw new Error('pkt-line length out of range');
    if (pos + len > buf.length) throw new Error('truncated pkt-line body');
    const raw = buf.subarray(pos + 4, pos + len);
    packets.push({ kind: 'data', text: raw.toString('utf8'), raw });
    pos += len;
  }
  return { packets, rest: buf.subarray(pos) };
}

// Split sideband band-1 packets out of a packfile section: each data packet
// starts with a band byte ('1' pack data, '2' progress, '3' error).
export function sidebandPackets(packBuf) {
  const out = [];
  const CHUNK = 65515; // 65520 max pkt-line - 4 header - 1 band byte
  const BAND = Buffer.from([1]); // binary band byte 0x01 (pack data)
  for (let i = 0; i < packBuf.length; i += CHUNK) {
    const chunk = packBuf.subarray(i, Math.min(i + CHUNK, packBuf.length));
    out.push(pktLine(Buffer.concat([BAND, chunk])));
  }
  if (out.length === 0) {
    // An empty pack still needs at least one sideband packet.
    out.push(pktLine(Buffer.concat([BAND, packBuf])));
  }
  return out;
}

// ------------------------------------------------------------ advertisements

const V0_UPLOAD_CAPS =
  'multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not filter agent=github-core-clone/1.0 symref=HEAD:refs/heads/main';
const V0_RECEIVE_CAPS =
  'report-status side-band-64k ofs-delta delete-refs agent=github-core-clone/1.0';

// All refs in advertisement order: HEAD first, then heads, then tags
// (peeled lines right after their annotated tag).
function refLines(repo) {
  const lines = [];
  const heads = [];
  const tags = [];
  for (const ref of [...repo.refs.keys()].sort()) {
    if (ref.startsWith('refs/heads/')) heads.push(ref);
    else if (ref.startsWith('refs/tags/')) tags.push(ref);
  }
  const mainTip = repo.branchTip('main');
  if (mainTip) lines.push({ oid: mainTip, ref: 'HEAD' });
  else if (heads.length > 0 || tags.length > 0) lines.push({ oid: ZERO_OID, ref: 'HEAD' });
  for (const ref of heads) lines.push({ oid: repo.refs.get(ref), ref });
  for (const ref of tags) {
    const oid = repo.refs.get(ref);
    lines.push({ oid, ref });
    const obj = repo.getObject(oid);
    if (obj && obj.type === 'tag') {
      const peeled = peelToCommit(repo.objects, oid);
      if (peeled) lines.push({ oid: peeled, ref: `${ref}^{}` });
    }
  }
  return lines;
}

export function advertisementV2() {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('server-option\n'),
    pktLine('object-format=sha1\n'),
    FLUSH,
  ]);
}

export function advertisementV0(repo, service) {
  const isReceive = service === 'git-receive-pack';
  const caps = isReceive ? V0_RECEIVE_CAPS : V0_UPLOAD_CAPS;
  const parts = [pktLine(`# service=${service}\n`), FLUSH];
  const lines = refLines(repo);
  if (lines.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    lines.forEach((line, i) => {
      const suffix = i === 0 ? `\0${caps}` : '';
      parts.push(pktLine(`${line.oid} ${line.ref}${suffix}\n`));
    });
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------- ls-refs

export function handleLsRefs(repo, args) {
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice(11));
  const matches = (name) => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));

  const lines = [];
  const mainTip = repo.branchTip('main');
  if (matches('HEAD')) {
    if (mainTip) {
      let line = `${mainTip} HEAD`;
      if (wantSymrefs) line += ' symref-target:refs/heads/main';
      lines.push(line + '\n');
    } else if (wantUnborn) {
      let line = 'unborn HEAD';
      if (wantSymrefs) line += ' symref-target:refs/heads/main';
      lines.push(line + '\n');
    }
  }
  for (const ref of [...repo.refs.keys()].sort()) {
    if (!matches(ref)) continue;
    const oid = repo.refs.get(ref);
    let line = `${oid} ${ref}`;
    const obj = repo.getObject(oid);
    if (wantPeel && obj && obj.type === 'tag') {
      const peeled = peelToCommit(repo.objects, oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    lines.push(line + '\n');
  }
  return Buffer.concat([...lines.map((l) => pktLine(l)), FLUSH]);
}

// ---------------------------------------------------------------------- fetch

// Add a tree's closure (tree objects + blobs, recursively) to `out`.
// `skip` is a set of oids to leave out; `collect` receives {oid,type,data}
// for every object added (or null to just record oids in `out`).
function addTreeClosure(repo, treeOid, out, collect) {
  const stack = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop();
    if (out.has(oid)) continue;
    const obj = repo.getObject(oid);
    if (!obj || obj.type !== 'tree') continue;
    out.add(oid);
    if (collect) collect(oid, obj);
    for (const e of parseTree(obj.data)) {
      if (e.isDir) stack.push(e.oid);
      else if (!out.has(e.oid)) {
        out.add(e.oid);
        if (collect) {
          const b = repo.getObject(e.oid);
          if (b) collect(e.oid, b);
        }
      }
    }
  }
}

// Compute the object set for a fetch: wants/haves/shallow/depth per the
// v2 fetch contract. Returns { objects: Map<oid,{type,data}>, shallowOut,
// unshallowOut }.
export function computeFetch(repo, { wants, haves, shallow, depth }) {
  const haveSet = new Set(haves);
  const shallowClient = new Set(shallow);
  const sendObjects = new Map();

  // Resolve wants to commits; tag objects are sent and peeled.
  const wantCommits = [];
  for (const w of wants) {
    const obj = repo.getObject(w);
    if (!obj) continue;
    if (obj.type === 'tag') {
      sendObjects.set(w, obj);
      let cur = w;
      const seen = new Set();
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        const o = repo.getObject(cur);
        if (!o) break;
        if (o.type === 'commit') { wantCommits.push(cur); break; }
        if (o.type === 'tag') {
          if (cur !== w) sendObjects.set(cur, o);
          cur = parseTag(o.data).object;
          continue;
        }
        break;
      }
    } else if (obj.type === 'commit') {
      wantCommits.push(w);
    }
  }

  // BFS walk from the wants, tracking distance. Expansion stops at a have
  // that is not shallow (the client already holds its ancestors) and at
  // the depth boundary.
  const dist = new Map();
  const queue = [];
  for (const c of wantCommits) {
    if (!dist.has(c)) { dist.set(c, 0); queue.push(c); }
  }
  const walked = new Set();
  for (let qi = 0; qi < queue.length; qi++) {
    const oid = queue[qi];
    walked.add(oid);
    const d = dist.get(oid);
    if (haveSet.has(oid) && !shallowClient.has(oid)) continue;
    if (depth !== null && depth !== undefined && d >= depth - 1) continue;
    const commit = repo.getCommit(oid);
    if (!commit) continue;
    for (const p of commit.parents) {
      if (!dist.has(p)) { dist.set(p, d + 1); queue.push(p); }
    }
  }

  const sendCommits = new Set([...walked].filter((c) => !haveSet.has(c)));

  // Held objects: full closure of non-shallow haves; depth-1 closure
  // (commit + its tree + blobs) of shallow haves.
  const held = new Set();
  for (const h of haves) {
    if (shallowClient.has(h)) {
      const c = repo.getCommit(h);
      if (!c) continue;
      held.add(h);
      addTreeClosure(repo, c.tree, held, null);
    } else {
      const stack = [h];
      const seen = new Set();
      while (stack.length > 0) {
        const cur = stack.pop();
        if (seen.has(cur)) continue;
        seen.add(cur);
        const c = repo.getCommit(cur);
        if (!c) continue;
        held.add(cur);
        addTreeClosure(repo, c.tree, held, null);
        for (const p of c.parents) stack.push(p);
      }
    }
  }

  // Trees/blobs of sent commits, minus held objects.
  for (const c of sendCommits) {
    const obj = repo.getObject(c);
    if (obj) sendObjects.set(c, obj);
    const commit = repo.getCommit(c);
    if (!commit) continue;
    const seen = new Set();
    addTreeClosure(repo, commit.tree, seen, (oid, o) => {
      if (!held.has(oid)) sendObjects.set(oid, o);
    });
    // Note: addTreeClosure's `seen` set already dedupes within this commit.
  }

  const shallowOut = [];
  const unshallowOut = [];
  if (depth !== null && depth !== undefined) {
    for (const c of sendCommits) {
      if (dist.get(c) === depth - 1) {
        const commit = repo.getCommit(c);
        if (commit && commit.parents.length > 0) shallowOut.push(c);
      }
    }
    for (const s of shallowClient) {
      if (!walked.has(s)) continue;
      const commit = repo.getCommit(s);
      if (commit && commit.parents.some((p) => sendCommits.has(p))) unshallowOut.push(s);
    }
  }
  return { objects: sendObjects, shallowOut, unshallowOut };
}

function cacheKeyFor(wants, haves, shallow, depth) {
  return JSON.stringify({
    w: [...wants].sort(),
    h: [...haves].sort(),
    s: [...shallow].sort(),
    d: depth ?? null,
  });
}

// Build (or reuse from cache) the full fetch result: pack bytes plus the
// shallow/unshallow lines. The cache lives on the repo and is cleared on
// any mutation, so repeated identical fetches (e.g. 50 concurrent clones)
// pay the walk only once.
export function getFetchResult(repo, fetchArgs) {
  const key = cacheKeyFor(fetchArgs.wants, fetchArgs.haves, fetchArgs.shallow, fetchArgs.depth);
  const cached = repo.packCache.get(key);
  if (cached) return cached;
  const { objects, shallowOut, unshallowOut } = computeFetch(repo, fetchArgs);
  const entries = [...objects.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([oid, o]) => ({ oid, type: o.type, data: o.data }));
  const pack = writePack(entries, repo.deflateCache);
  const result = { pack, shallowOut, unshallowOut };
  repo.packCache.set(key, result);
  return result;
}

// ---------------------------------------------------------------- v2 upload-pack

export function handleUploadPackV2(repo, body) {
  const { packets } = parsePktLines(body);
  const texts = packets.filter((p) => p.kind === 'data').map((p) => p.text);
  if (texts.length === 0) throw new Error('empty v2 request');
  const commandLine = texts[0].trim();
  // Split args at the delim packet.
  const delimIdx = packets.findIndex((p) => p.kind === 'delim');
  const argTexts = (delimIdx === -1 ? texts.slice(1) : packets
    .slice(delimIdx + 1)
    .filter((p) => p.kind === 'data')
    .map((p) => p.text)).map((t) => t.replace(/\n$/, ''));

  if (commandLine === 'command=ls-refs') {
    return handleLsRefs(repo, argTexts);
  }
  if (commandLine !== 'command=fetch') throw new Error(`unknown v2 command ${commandLine}`);

  const wants = [];
  const haves = [];
  const shallow = [];
  let depth = null;
  for (const a of argTexts) {
    if (a.startsWith('want ')) wants.push(a.slice(5).trim());
    else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
    else if (a.startsWith('shallow ')) shallow.push(a.slice(8).trim());
    else if (a.startsWith('deepen ')) depth = parseInt(a.slice(7), 10);
  }
  const fetchArgs = { wants, haves, shallow, depth };
  const { pack, shallowOut, unshallowOut } = getFetchResult(repo, fetchArgs);

  const parts = [pktLine('acknowledgments\n')];
  const knownHaves = haves.filter((h) => repo.getObject(h));
  if (knownHaves.length === 0) parts.push(pktLine('NAK\n'));
  else for (const h of knownHaves) parts.push(pktLine(`ACK ${h}\n`));
  parts.push(DELIM);
  if (shallowOut.length > 0 || unshallowOut.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of shallowOut) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of unshallowOut) parts.push(pktLine(`unshallow ${s}\n`));
    parts.push(DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- v0 upload-pack

export function handleUploadPackV0(repo, body) {
  const { packets } = parsePktLines(body);
  const wants = [];
  const haves = [];
  const shallow = [];
  let depth = null;
  let seenFlush = false;
  for (const p of packets) {
    if (p.kind === 'flush') { seenFlush = true; continue; }
    if (p.kind !== 'data') continue;
    let text = p.text.replace(/\n$/, '');
    // First want line carries capabilities after a NUL byte.
    const nul = text.indexOf('\0');
    if (nul !== -1) text = text.slice(0, nul);
    if (text.startsWith('want ')) wants.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) depth = parseInt(text.slice(7), 10);
    else if (text.startsWith('have ') && seenFlush) haves.push(text.slice(5).trim());
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
  }
  const fetchArgs = { wants, haves, shallow, depth };
  const { pack, shallowOut, unshallowOut } = getFetchResult(repo, fetchArgs);
  const parts = [];
  const knownHaves = haves.filter((h) => repo.getObject(h));
  if (knownHaves.length === 0) parts.push(pktLine('NAK\n'));
  else for (const h of knownHaves) parts.push(pktLine(`ACK ${h}\n`));
  for (const s of shallowOut) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of unshallowOut) parts.push(pktLine(`unshallow ${s}\n`));
  parts.push(...sidebandPackets(pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack

export function handleReceivePack(repo, body) {
  const { packets, rest } = parsePktLines(body);
  const commands = [];
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    let text = p.text.replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul !== -1) text = text.slice(0, nul);
    const m = text.match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/);
    if (!m) throw new Error('bad receive-pack command line');
    commands.push({ old: m[1], next: m[2], ref: m[3] });
  }
  if (commands.length === 0) throw new Error('no ref commands in receive-pack');

  // Unpack (delete-only pushes carry no pack).
  const hasPack = rest.length > 0;
  let unpacked = null;
  if (hasPack) {
    unpacked = readPack(rest, repo.objects);
  }

  const results = []; // { ref, ok, reason }
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref) ?? ZERO_OID;
    const isDelete = cmd.next === ZERO_OID;
    const isCreate = cmd.old === ZERO_OID;
    const isTag = cmd.ref.startsWith('refs/tags/');
    if (cmd.old !== current) {
      results.push({ ref: cmd.ref, ok: false, reason: 'stale info' });
      continue;
    }
    if (isDelete) {
      repo.deleteRef(cmd.ref);
      results.push({ ref: cmd.ref, ok: true });
      continue;
    }
    if (isTag && !isCreate) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    // The new object must exist (in the pack or already in the repo).
    const newObj = (unpacked && unpacked.get(cmd.next)) || repo.getObject(cmd.next);
    if (!newObj) {
      results.push({ ref: cmd.ref, ok: false, reason: 'missing object' });
      continue;
    }
    if (!isCreate) {
      // Fast-forward check: the old tip must be an ancestor of the new tip.
      // Look up objects in the unpacked pack first, then the repo — no
      // need to copy the object map for this.
      const getObj = (oid) => (unpacked && unpacked.get(oid)) || repo.getObject(oid);
      const newCommit = newObj.type === 'tag' ? peelToCommit(getObj, cmd.next) : cmd.next;
      const ff = isAncestor(getObj, current, newCommit) || current === newCommit;
      if (!ff) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    repo.setRef(cmd.ref, cmd.next);
    results.push({ ref: cmd.ref, ok: true });
  }

  // Only now commit the unpacked objects to the store.
  if (unpacked) {
    for (const [oid, obj] of unpacked) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    }
    repo.mutate();
  }

  // Report stream, inner pkt-framed, wrapped in sideband band 1.
  const inner = [pktLine('unpack ok\n')];
  for (const r of results) {
    inner.push(r.ok ? pktLine(`ok ${r.ref}\n`) : pktLine(`ng ${r.ref} ${r.reason}\n`));
  }
  inner.push(FLUSH);
  const innerBuf = Buffer.concat(inner);
  const parts = [];
  const CHUNK = 65515;
  const BAND = Buffer.from([1]); // binary band byte 0x01
  for (let i = 0; i < innerBuf.length; i += CHUNK) {
    parts.push(pktLine(Buffer.concat([BAND, innerBuf.subarray(i, i + CHUNK)])));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ routing

const GIT_PATH_RE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

// Returns { repo } or null when the path is not a git endpoint, or throws
// a { status, message } object for auth/repo failures.
export function matchGitPath(path) {
  const m = GIT_PATH_RE.exec(path);
  if (!m) return null;
  return { owner: decodeURIComponent(m[1]), name: decodeURIComponent(m[2]), endpoint: m[3] };
}

export { VIEWER_LOGIN, getRepo };

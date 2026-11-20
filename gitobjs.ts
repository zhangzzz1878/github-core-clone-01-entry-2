// gitobjs.ts — pure git object model: hashing, commit/tree/tag codecs,
// packfile read/write (with delta resolution), tree flattening, diffing,
// ancestry and merge-base. No store dependency: callers pass a Map of
// objects (oid -> { type, data }). All plain JS in a .ts file so it runs
// under Node's type stripping with no build step.

import { createHash } from 'node:crypto';
import zlib from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export const OBJ_TYPE = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const TYPE_NAME = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag', 6: 'ofs-delta', 7: 'ref-delta' };

const SHA1_RE = /^[0-9a-f]{40}$/;
export function isOid(s) {
  return typeof s === 'string' && SHA1_RE.test(s);
}

// SHA-1 over "<type> <size>\0" + payload, exactly as git computes it.
export function hashObject(type, data) {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

// ---------------------------------------------------------------- commits

export function parseCommit(data) {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const out = { tree: null, parents: [], author: '', committer: '', message, raw: data };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) out.author = line.slice(7);
    else if (line.startsWith('committer ')) out.committer = line.slice(10);
  }
  return out;
}

export function buildCommit({ tree, parents, message, authorName, authorEmail, ts }) {
  const ident = `${authorName} <${authorEmail}> ${ts} +0000`;
  let s = `tree ${tree}\n`;
  for (const p of parents) s += `parent ${p}\n`;
  s += `author ${ident}\ncommitter ${ident}\n\n${message}`;
  if (!message.endsWith('\n')) s += '\n';
  return Buffer.from(s, 'utf8');
}

// ------------------------------------------------------------------- trees

// Parse a raw tree object into [{ mode, name, oid, isDir }].
export function parseTree(data) {
  const entries = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const mode = data.toString('ascii', i, sp);
    const nul = data.indexOf(0x00, sp + 1);
    const name = data.toString('utf8', sp + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid, isDir: mode === '40000' });
    i = nul + 21;
  }
  return entries;
}

// Git's tree sort: directory names compare as if suffixed with '/'.
export function compareTreeNames(aName, aIsDir, bName, bIsDir) {
  const a = aIsDir ? aName + '/' : aName;
  const b = bIsDir ? bName + '/' : bName;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return Buffer.compare(ab, bb);
}

export function buildTree(entries) {
  const sorted = [...entries].sort((x, y) =>
    compareTreeNames(x.name, x.isDir, y.name, y.isDir));
  const parts = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------- tags

export function parseTag(data) {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const out = { object: null, type: null, tag: '', tagger: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7).trim();
    else if (line.startsWith('type ')) out.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) out.tag = line.slice(4);
    else if (line.startsWith('tagger ')) out.tagger = line.slice(7);
  }
  return out;
}

// Peel a tag chain down to a commit oid (or null if it never reaches one).
// `objects` is a Map or a getter function (oid -> { type, data } | null).
export function peelToCommit(objects, oid) {
  const get = typeof objects === 'function' ? objects : (o) => objects.get(o) ?? null;
  let cur = oid;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const obj = get(cur);
    if (!obj) return null;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') {
      cur = parseTag(obj.data).object;
      continue;
    }
    return null;
  }
  return null;
}

// ------------------------------------------------------- tree flatten/diff

// Flatten a commit's tree into Map<path, { oid, mode }>. Recursive; callers
// cache the result per commit oid.
export function flattenTree(objects, treeOid, out = new Map(), prefix = '') {
  const obj = objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const path = prefix + e.name;
    if (e.isDir) flattenTree(objects, e.oid, out, path + '/');
    else out.set(path, { oid: e.oid, mode: e.mode });
  }
  return out;
}

// Build nested tree objects from a flat path map, storing them into
// `objects`, and return the root tree oid.
export function buildTreeFromMap(objects, flat) {
  function build(prefix) {
    const files = [];
    const dirs = new Set();
    for (const path of flat.keys()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) files.push({ name: rest, oid: flat.get(path).oid });
      else dirs.add(rest.slice(0, slash));
    }
    const entries = [];
    for (const f of files) entries.push({ mode: '100644', name: f.name, oid: f.oid, isDir: false });
    for (const d of dirs) {
      entries.push({ mode: '40000', name: d, oid: build(prefix + d + '/'), isDir: true });
    }
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    objects.set(oid, { type: 'tree', data });
    return oid;
  }
  return build('');
}

// Diff two flattened trees: [{ path, status, oldOid, newOid }].
// status is 'added' | 'removed' | 'modified'.
export function diffFlatMaps(base, head) {
  const out = [];
  for (const [path, h] of head) {
    const b = base.get(path);
    if (!b) out.push({ path, status: 'added', oldOid: null, newOid: h.oid });
    else if (b.oid !== h.oid) out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid });
  }
  for (const [path, b] of base) {
    if (!head.has(path)) out.push({ path, status: 'removed', oldOid: b.oid, newOid: null });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

// Count added/removed lines between two blob buffers via multiset line diff.
export function lineDiffCounts(oldBuf, newBuf) {
  const oldLines = splitLines(oldBuf);
  const newLines = splitLines(newBuf);
  if (oldLines.length === 0) return { additions: newLines.length, deletions: 0 };
  if (newLines.length === 0) return { additions: 0, deletions: oldLines.length };
  const counts = new Map();
  for (const l of oldLines) counts.set(l, (counts.get(l) ?? 0) + 1);
  let additions = 0;
  for (const l of newLines) {
    const c = counts.get(l) ?? 0;
    if (c > 0) counts.set(l, c - 1);
    else additions++;
  }
  let deletions = 0;
  for (const c of counts.values()) deletions += c;
  return { additions, deletions };
}

function splitLines(buf) {
  if (!buf || buf.length === 0) return [];
  const text = buf.toString('utf8');
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

// --------------------------------------------------------------- ancestry

export function getParsedCommit(objects, oid) {
  const obj = typeof objects === 'function' ? objects(oid) : objects.get(oid);
  if (!obj || obj.type !== 'commit') return null;
  return parseCommit(obj.data);
}

// Is `ancestor` reachable from `descendant` following parent links?
// `objects` is a Map or a getter function.
export function isAncestor(objects, ancestor, descendant) {
  if (ancestor === descendant) return true;
  const get = typeof objects === 'function' ? objects : (o) => objects.get(o) ?? null;
  const seen = new Set();
  const stack = [descendant];
  let guard = 0;
  while (stack.length > 0 && guard++ < 200000) {
    const cur = stack.pop();
    if (cur === ancestor) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = get(cur);
    if (!obj || obj.type !== 'commit') continue;
    const c = parseCommit(obj.data);
    for (const p of c.parents) stack.push(p);
  }
  return false;
}

// Lowest common ancestor of two commits (BFS from both sides).
export function mergeBase(objects, a, b) {
  if (!a || !b) return null;
  if (a === b) return a;
  const distA = new Map([[a, 0]]);
  const qa = [a];
  let ia = 0;
  let guard = 0;
  while (ia < qa.length && guard++ < 200000) {
    const cur = qa[ia++];
    const c = getParsedCommit(objects, cur);
    if (!c) continue;
    for (const p of c.parents) {
      if (!distA.has(p)) { distA.set(p, distA.get(cur) + 1); qa.push(p); }
    }
  }
  const seenB = new Set([b]);
  const qb = [b];
  let ib = 0;
  guard = 0;
  let best = null;
  let bestDist = Infinity;
  while (ib < qb.length && guard++ < 200000) {
    const cur = qb[ib++];
    if (distA.has(cur)) {
      const d = distA.get(cur) + ib; // rough combined distance; first hit wins on ties
      if (d < bestDist) { bestDist = d; best = cur; }
    }
    const c = getParsedCommit(objects, cur);
    if (!c) continue;
    for (const p of c.parents) {
      if (!seenB.has(p)) { seenB.add(p); qb.push(p); }
    }
  }
  return best;
}

// ------------------------------------------------------------- pack writing

// Encode one pack entry (header varint + zlib deflate). Returns Buffer.
export function encodePackEntry(type, data) {
  const typeNum = OBJ_TYPE[type];
  const size = data.length;
  const header = [];
  let b = (typeNum << 4) | (size & 0x0f);
  let rest = size >> 4;
  if (rest !== 0) b |= 0x80;
  header.push(b);
  while (rest !== 0) {
    b = rest & 0x7f;
    rest >>= 7;
    if (rest !== 0) b |= 0x80;
    header.push(b);
  }
  const deflated = zlib.deflateSync(data);
  return Buffer.concat([Buffer.from(header), deflated]);
}

// Build a version-2 pack from entries [{ oid, type, data }] (plain objects,
// no deltas). `entryCache` (Map oid -> encoded entry Buffer) is optional.
export function writePack(entries, entryCache) {
  const chunks = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  chunks.push(header);
  for (const e of entries) {
    let encoded;
    if (entryCache && entryCache.has(e.oid)) encoded = entryCache.get(e.oid);
    else {
      encoded = encodePackEntry(e.type, e.data);
      if (entryCache) entryCache.set(e.oid, encoded);
    }
    chunks.push(encoded);
  }
  const body = Buffer.concat(chunks);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// -------------------------------------------------------------- pack reading

// Adler-32 checksum (used to locate the end of a zlib stream: the
// stream's last 4 bytes are the big-endian Adler-32 of its output).
function adler32(buf) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// Find the exact length of the zlib stream starting at `offset` in `buf`
// (searching within [offset, limit)). inflateSync tolerates trailing data,
// so one inflate yields the output; the stream ends with that output's
// Adler-32, and the earliest candidate end that re-inflates to the same
// output is the true boundary.
function zlibStreamLength(buf, offset, limit) {
  let expected;
  try {
    expected = zlib.inflateSync(buf.subarray(offset, limit));
  } catch {
    return -1;
  }
  const needle = Buffer.alloc(4);
  needle.writeUInt32BE(adler32(expected), 0);
  let from = offset + 2;
  while (true) {
    const idx = buf.indexOf(needle, from);
    if (idx === -1 || idx + 4 > limit) return -1;
    const end = idx + 4;
    try {
      const out = zlib.inflateSync(buf.subarray(offset, end));
      if (out.equals(expected)) return end - offset;
    } catch {
      // False Adler match inside the deflate data: keep scanning.
    }
    from = idx + 1;
  }
}

function readSizeEncoding(buf, pos) {
  let b = buf[pos++];
  const typeNum = (b >> 4) & 0x07;
  let size = b & 0x0f;
  let shift = 4;
  while (b & 0x80) {
    b = buf[pos++];
    size |= (b & 0x7f) << shift;
    shift += 7;
  }
  return { typeNum, size, next: pos };
}

function readOfsDeltaOffset(buf, pos) {
  let b = buf[pos++];
  let offset = b & 0x7f;
  while (b & 0x80) {
    b = buf[pos++];
    offset = ((offset + 1) << 7) | (b & 0x7f);
  }
  return { offset, next: pos };
}

// Apply a git delta to a base buffer.
export function applyDelta(base, delta) {
  let pos = 0;
  const readVarint = () => {
    let result = 0;
    let shift = 0;
    let b;
    do {
      b = delta[pos++];
      result |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    return result;
  };
  const srcSize = readVarint();
  const tgtSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta source size mismatch');
  const out = Buffer.alloc(tgtSize);
  let outPos = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i++) {
        if (op & (1 << i)) cpOff |= delta[pos++] << (8 * i);
      }
      for (let i = 0; i < 3; i++) {
        if (op & (0x10 << i)) cpSize |= delta[pos++] << (8 * i);
      }
      if (cpSize === 0) cpSize = 0x10000;
      base.copy(out, outPos, cpOff, cpOff + cpSize);
      outPos += cpSize;
    } else if (op !== 0) {
      delta.copy(out, outPos, pos, pos + op);
      pos += op;
      outPos += op;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (outPos !== tgtSize) throw new Error('delta target size mismatch');
  return out;
}

// Parse a packfile buffer into Map<oid, { type, data }>. Resolves OFS and
// REF deltas; REF deltas may also resolve against `baseObjects` (objects
// already in the repo). Verifies each object's SHA-1.
export function readPack(buf, baseObjects) {
  if (buf.length < 32) throw new Error('pack too short');
  if (buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('bad pack magic');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const end = buf.length - 20; // trailer
  const raw = []; // { offset, typeNum, size, data, baseOid?, baseOffset? }
  let pos = 12;
  for (let i = 0; i < count; i++) {
    const entryStart = pos;
    const { typeNum, size, next } = readSizeEncoding(buf, pos);
    pos = next;
    let baseOid = null;
    let baseOffset = null;
    if (typeNum === 6) {
      const r = readOfsDeltaOffset(buf, pos);
      baseOffset = entryStart - r.offset;
      pos = r.next;
    } else if (typeNum === 7) {
      baseOid = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    }
    const len = zlibStreamLength(buf, pos, end);
    if (len < 0) throw new Error('bad deflate stream in pack');
    const data = zlib.inflateSync(buf.subarray(pos, pos + len));
    pos += len;
    raw.push({ offset: entryStart, typeNum, size, data, baseOid, baseOffset });
  }
  // Resolve entries in order (ofs bases always precede their deltas).
  const byOffset = new Map();
  const out = new Map();
  const resolve = (entry) => {
    if (entry.resolved) return entry.resolved;
    let type;
    let data;
    if (entry.typeNum === 6 || entry.typeNum === 7) {
      let base;
      if (entry.typeNum === 6) {
        const baseEntry = byOffset.get(entry.baseOffset);
        if (!baseEntry) throw new Error('ofs-delta base not found');
        base = resolve(baseEntry);
      } else {
        const inPack = out.get(entry.baseOid);
        if (inPack) base = inPack;
        else if (baseObjects && baseObjects.has(entry.baseOid)) base = baseObjects.get(entry.baseOid);
        else throw new Error('ref-delta base not found');
      }
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else {
      type = TYPE_NAME[entry.typeNum];
      if (!type) throw new Error(`unknown object type ${entry.typeNum}`);
      data = entry.data;
    }
    if (data.length !== entry.size) throw new Error('object size mismatch in pack');
    const oid = hashObject(type, data);
    const resolved = { type, data, oid };
    entry.resolved = resolved;
    byOffset.set(entry.offset, entry);
    out.set(oid, { type, data });
    return resolved;
  };
  for (const entry of raw) {
    // Register offsets first so ofs-delta lookup works for later entries.
    byOffset.set(entry.offset, entry);
  }
  // Resolve in passes: a ref-delta's base may sit later in the pack.
  let pending = [...raw];
  let progress = true;
  while (pending.length > 0 && progress) {
    progress = false;
    const next = [];
    for (const entry of pending) {
      try {
        resolve(entry);
        progress = true;
      } catch (e) {
        if (e && e.message === 'ref-delta base not found') next.push(entry);
        else throw e;
      }
    }
    pending = next;
  }
  if (pending.length > 0) throw new Error('ref-delta base not found');
  return out;
}

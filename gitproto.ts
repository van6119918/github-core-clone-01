// git smart HTTP: pkt-lines, packfiles, and the upload-pack / receive-pack handlers.
// The wire format mirrors the suite's own git-client.ts, so the bytes agree with its parser.

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  store,
  type GitObject,
  type GitObjectType,
  type Repo,
  ZERO_OID,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  collectReachable,
} from './store.ts';

// -------------------------------------------------------------------------------------------------
// pkt-lines
// -------------------------------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export interface Pkt {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}

/** Decode a whole buffer of pkt-lines. Throws on garbage. */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line length');
    const hex = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('bad pkt-line length prefix');
    const len = parseInt(hex, 16);
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (len < 4 || offset + len > buf.length) {
      throw new Error('bad pkt-line length');
    } else {
      out.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
      offset += len;
    }
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// packfiles
// -------------------------------------------------------------------------------------------------

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

export function writePack(objects: { type: GitObjectType; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const o of objects) {
    parts.push(writePackObjectHeader(o.type, o.data.length));
    parts.push(deflateSync(o.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + written };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit++) {
        if (op & (1 << bit)) copyOffset += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit++) {
        if (op & (1 << bit)) copySize += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

export interface PackRead {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/** Read a packfile (v2/v3), resolving OFS_DELTA and REF_DELTA entries. */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackRead {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack has no PACK header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolved?: Buffer;
    resolvedType?: GitObjectType;
    oid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let i = 0; i < declaredCount; i++) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before trailer');

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  let deltaCount = 0;
  const resolve = (entry: Raw): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} missing`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode]!;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const r = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount++;
    if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type, data: r.data });
  }
  return { objects, deltaCount };
}

// -------------------------------------------------------------------------------------------------
// ref helpers
// -------------------------------------------------------------------------------------------------

export interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
}

/** All refs of a repo, sorted: HEAD first (when it resolves), then branches, then tags. */
export function listRefs(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const main = repo.refs.get('refs/heads/main');
  if (main) out.push({ oid: main, name: 'HEAD', symrefTarget: 'refs/heads/main' });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const line: RefLine = { oid, name };
    if (name.startsWith('refs/tags/')) {
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') line.peeled = parseTag(obj.data).object;
    }
    out.push(line);
  }
  return out;
}

/** Is `descendant` a descendant of (or equal to) `ancestor`? */
export function isDescendant(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid) || !isObjectId(oid)) continue;
    seen.add(oid);
    if (oid === ancestor) return true;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return false;
}

// -------------------------------------------------------------------------------------------------
// advertisements
// -------------------------------------------------------------------------------------------------

const UPLOAD_V2_CAPS = ['ls-refs=unborn', 'fetch=shallow', 'object-format=sha1', 'agent=git-forge/1.0'];

export function v2Advertisement(): Buffer {
  const parts: Buffer[] = [pktLine('version 2\n')];
  for (const cap of UPLOAD_V2_CAPS) parts.push(pktLine(`${cap}\n`));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v0Advertisement(repo: Repo, service: string, caps: string): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`)];
  const refs = listRefs(repo);
  const firstLine = (oid: string, name: string): Buffer => pktLine(`${oid} ${name}\0${caps}\n`);
  if (refs.length === 0) {
    parts.push(firstLine(ZERO_OID, 'capabilities^{}'));
  } else {
    refs.forEach((ref, i) => {
      parts.push(i === 0 ? firstLine(ref.oid, ref.name) : pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function uploadPackAdvertisement(repo: Repo, protocolV2: boolean): Buffer {
  if (protocolV2) return v2Advertisement();
  return v0Advertisement(
    repo,
    'git-upload-pack',
    'side-band-64k thin-pack ofs-delta shallow multi_ack symref=HEAD:refs/heads/main agent=git-forge/1.0',
  );
}

export function receivePackAdvertisement(repo: Repo): Buffer {
  return v0Advertisement(
    repo,
    'git-receive-pack',
    'report-status side-band-64k delete-refs thin-pack ofs-delta symref=HEAD:refs/heads/main agent=git-forge/1.0',
  );
}

// -------------------------------------------------------------------------------------------------
// upload-pack: ls-refs (v2)
// -------------------------------------------------------------------------------------------------

export function handleLsRefs(repo: Repo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const a of args) {
    if (a === 'peel') peel = true;
    else if (a === 'symrefs') symrefs = true;
    else if (a === 'unborn') unborn = true;
    else if (a.startsWith('ref-prefix ')) prefixes.push(a.slice('ref-prefix '.length));
  }
  const refs = listRefs(repo);
  const parts: Buffer[] = [];
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  for (const ref of refs) {
    if (!matches(ref.name)) continue;
    if (ref.name === 'HEAD' && prefixes.length > 0) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    if (symrefs && ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
    parts.push(pktLine(`${line}\n`));
  }
  if (refs.length === 0 && unborn) {
    parts.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------------
// upload-pack: fetch (v2 and v0)
// -------------------------------------------------------------------------------------------------

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenSince: number | null;
}

/** Objects to send for a fetch: reachable from wants (within depth) minus reachable from haves. */
export function computeFetch(
  repo: Repo,
  req: FetchRequest,
): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  // Expand wants: a tag want contributes the tag object itself plus its target commit.
  const tagObjects = new Set<string>();
  const commitWants: string[] = [];
  for (const w of req.wants) {
    if (!isObjectId(w)) continue;
    const obj = lookup(w);
    if (!obj) continue;
    if (obj.type === 'tag') {
      tagObjects.add(w);
      const target = parseTag(obj.data).object;
      if (isObjectId(target)) commitWants.push(target);
    } else if (obj.type === 'commit') {
      commitWants.push(w);
    } else {
      // A tree/blob want: send it directly.
      tagObjects.add(w);
    }
  }
  // Commit closure with depth: distance from a want; boundary commits are shallow.
  const dist = new Map<string, number>();
  const queue: { oid: string; d: number }[] = [];
  for (const w of commitWants) {
    if (!dist.has(w)) {
      dist.set(w, 0);
      queue.push({ oid: w, d: 0 });
    }
  }
  const includedCommits = new Set<string>();
  const shallowSet = new Set<string>();
  while (queue.length) {
    const { oid, d } = queue.shift()!;
    const obj = lookup(oid);
    if (!obj || obj.type !== 'commit') continue;
    includedCommits.add(oid);
    const c = parseCommit(obj.data);
    if (req.depth !== null && d >= req.depth - 1) {
      // At the depth boundary: this commit is shallow, its parents are cut off.
      shallowSet.add(oid);
      continue;
    }
    for (const p of c.parents) {
      if (!dist.has(p)) {
        dist.set(p, d + 1);
        queue.push({ oid: p, d: d + 1 });
      }
    }
  }
  // Object closure of the included commits, never crossing the depth cut.
  const wanted = new Set<string>(tagObjects);
  const seenTrees = new Set<string>();
  const addTree = (treeOid: string): void => {
    if (seenTrees.has(treeOid)) return;
    const tree = lookup(treeOid);
    if (!tree || tree.type !== 'tree') return;
    seenTrees.add(treeOid);
    wanted.add(treeOid);
    for (const e of parseTree(tree.data)) {
      if (e.mode === '160000') continue;
      if (e.mode === '40000') addTree(e.oid);
      else wanted.add(e.oid);
    }
  };
  for (const oid of includedCommits) {
    wanted.add(oid);
    const c = parseCommit(lookup(oid)!.data);
    addTree(c.tree);
  }
  // What the client already holds. A have that is also one of the client's shallow boundaries
  // contributes only itself and its tree: the client does NOT hold that commit's parents, and a
  // deepen must deliver them. So the walk stops at shallow boundaries instead of following them.
  const held = new Set<string>();
  if (req.haves.length) {
    const shallowSet = new Set(req.shallow);
    const seenCommits = new Set<string>();
    const seenTrees = new Set<string>();
    const addHeldTree = (treeOid: string): void => {
      if (seenTrees.has(treeOid)) return;
      const tree = lookup(treeOid);
      if (!tree || tree.type !== 'tree') return;
      seenTrees.add(treeOid);
      held.add(treeOid);
      for (const e of parseTree(tree.data)) {
        if (e.mode === '160000') continue;
        if (e.mode === '40000') addHeldTree(e.oid);
        else held.add(e.oid);
      }
    };
    const queue = [...req.haves];
    while (queue.length) {
      const oid = queue.shift()!;
      if (!isObjectId(oid)) continue;
      const obj = lookup(oid);
      if (!obj) continue;
      if (obj.type === 'commit') {
        if (seenCommits.has(oid)) continue;
        seenCommits.add(oid);
        held.add(oid);
        addHeldTree(parseCommit(obj.data).tree);
        if (shallowSet.has(oid)) continue; // shallow boundary: the client lacks the parents
        for (const p of parseCommit(obj.data).parents) queue.push(p);
      } else if (obj.type === 'tag') {
        held.add(oid);
        const target = parseTag(obj.data).object;
        if (isObjectId(target)) queue.push(target);
      } else {
        held.add(oid);
      }
    }
  }
  // Shallow boundary bookkeeping for deepen: old shallow lines that are now fully included.
  const unshallow: string[] = [];
  if (req.depth !== null) {
    for (const s of req.shallow) {
      if (includedCommits.has(s) && !shallowSet.has(s)) unshallow.push(s);
    }
  }
  const objects: GitObject[] = [];
  for (const oid of wanted) {
    if (held.has(oid)) continue;
    const obj = lookup(oid);
    if (obj) objects.push(obj);
  }
  return { objects, shallow: [...shallowSet], unshallow };
}

const SIDEBAND_CHUNK = 65515;

function sidebandPackets(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  for (let off = 0; off < pack.length; off += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(off, Math.min(off + SIDEBAND_CHUNK, pack.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  return parts;
}

export function handleFetchV2(repo: Repo, req: FetchRequest): Buffer {
  const { objects, shallow, unshallow } = computeFetch(repo, req);
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), pktDelim());
  if (shallow.length || unshallow.length) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const u of unshallow) parts.push(pktLine(`unshallow ${u}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function handleFetchV0(repo: Repo, req: FetchRequest): Buffer {
  const { objects, shallow, unshallow } = computeFetch(repo, req);
  const pack = writePack(objects);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const u of unshallow) parts.push(pktLine(`unshallow ${u}\n`));
  parts.push(...sidebandPackets(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------------
// receive-pack
// -------------------------------------------------------------------------------------------------

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Apply a receive-pack exchange. Returns the report-status bytes (already sideband-framed). */
export function handleReceivePack(repo: Repo, body: Buffer): { report: Buffer; status: number } {
  // Parse pkt-lines up to the flush; the rest is the pack.
  let offset = 0;
  const commands: PushCommand[] = [];
  let packStart = body.length;
  try {
    while (offset + 4 <= body.length) {
      const hex = body.subarray(offset, offset + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('bad pkt-line');
      const len = parseInt(hex, 16);
      if (len === 0) {
        packStart = offset + 4;
        break;
      }
      if (len < 4 || offset + len > body.length) throw new Error('bad pkt-line length');
      const payload = body.subarray(offset + 4, offset + len).toString('utf8');
      const nul = payload.indexOf('\0');
      const line = (nul >= 0 ? payload.slice(0, nul) : payload).replace(/\n$/, '');
      const parts = line.split(' ');
      if (parts.length >= 3 && isObjectId(parts[0]!) && isObjectId(parts[1]!)) {
        commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
      }
      offset += len;
    }
  } catch {
    return { report: reportStatus(false, 'unpack error', []), status: 200 };
  }
  if (commands.length === 0) {
    return { report: reportStatus(false, 'unpack error', []), status: 200 };
  }

  // Unpack.
  const updatesRef = commands.some((c) => c.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = 'ok';
  let packObjects = new Map<string, GitObject>();
  if (packStart < body.length) {
    try {
      packObjects = readPack(body.subarray(packStart), (oid) => repo.objects.get(oid)).objects;
    } catch {
      unpackOk = false;
      unpackDetail = 'unpack error';
    }
  } else if (updatesRef) {
    // A ref update with no pack at all cannot carry the new objects.
    unpackOk = false;
    unpackDetail = 'unpack error';
  }
  if (unpackOk) {
    for (const [oid, obj] of packObjects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    }
  }

  // Validate each command; apply the ok ones.
  const results: { ref: string; ok: boolean; reason: string }[] = [];
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    let ok = false;
    let reason = '';
    if (!unpackOk) {
      reason = 'unpack error';
    } else if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) reason = 'ref does not exist';
      else if (current !== cmd.oldOid) reason = 'non-fast-forward';
      else ok = true;
    } else if (cmd.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) reason = 'already exists';
      else {
        // The new tip must be present in the store now.
        const tip = repo.objects.get(cmd.newOid);
        if (!tip) reason = 'missing object';
        else ok = true;
      }
    } else {
      // Update.
      if (current === undefined) reason = 'ref does not exist';
      else if (current !== cmd.oldOid) reason = 'non-fast-forward';
      else if (!isDescendant(repo, cmd.oldOid, cmd.newOid)) reason = 'non-fast-forward';
      else {
        const tip = repo.objects.get(cmd.newOid);
        if (!tip) reason = 'missing object';
        else ok = true;
      }
    }
    if (ok) {
      if (cmd.newOid === ZERO_OID) repo.refs.delete(cmd.ref);
      else repo.refs.set(cmd.ref, cmd.newOid);
    }
    results.push({ ref: cmd.ref, ok, reason });
  }
  return { report: reportStatus(unpackOk, unpackDetail, results), status: 200 };
}

/** The report-status stream, framed as sideband band-1 pkt-lines. */
function reportStatus(
  unpackOk: boolean,
  unpackDetail: string,
  refs: { ref: string; ok: boolean; reason: string }[],
): Buffer {
  const lines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const r of refs) {
    lines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
  }
  const stream = Buffer.concat(lines.map((l) => pktLine(l)));
  // One band-1 packet holding the whole stream, then the response flush.
  return Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), stream])), pktFlush()]);
}

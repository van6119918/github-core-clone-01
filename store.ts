// The forge's in-memory store: repositories, git objects, issues, pull requests, labels.
//
// One process, no persistence: the trial starts a fresh server and the suite builds every
// fixture through the API, so everything lives in Maps and dies with the process.

import { createHash } from 'node:crypto';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';
export const ZERO_OID = '0'.repeat(40);

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export function hashObject(type: GitObjectType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  h.update(data);
  return h.digest('hex');
}

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree object');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const l = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const r = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(l, r);
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerText = data.subarray(0, blank < 0 ? data.length : blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const value = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isObjectId(tree)) throw new Error('commit has no valid tree');
  return { tree, parents, author, committer, message };
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const blank = data.indexOf('\n\n');
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, blank < 0 ? data.length : blank).toString('utf8').split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    headers.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Every object reachable from roots (commit -> tree + parents, tree -> entries, tag -> target). */
export function collectReachable(
  roots: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const r of roots) if (isObjectId(r)) queue.push(r);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj) throw new Error(`object ${oid} is missing from the store`);
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      queue.push(c.tree);
      for (const p of c.parents) queue.push(p);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (e.mode !== '160000') queue.push(e.oid);
      }
    }
  }
  return seen;
}

/** Flat path -> blob oid of a tree, recursively. */
export function flattenTree(
  treeOid: string,
  lookup: (oid: string) => GitObject | undefined,
  prefix = '',
  out = new Map<string, string>(),
): Map<string, string> {
  const obj = lookup(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') flattenTree(e.oid, lookup, path, out);
    else if (e.mode !== '160000') out.set(path, e.oid);
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// Issues, pull requests, repositories
// -------------------------------------------------------------------------------------------------

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  comments: { id: number; body: string; createdSeq: number }[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  createdSeq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  createdSeq: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, { name: string; color: string }>;
  nextIssue: number;
  nextPull: number;
  nextCommentId: number;
  nextIssueId: number;
  nextPullId: number;
}

export class Store {
  repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextSeq = 1;
  private nextGlobalId = 1;

  seq(): number {
    return this.nextSeq++;
  }

  globalId(): number {
    return this.nextGlobalId++;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner,
      description,
      isPrivate,
      createdSeq: this.seq(),
      refs: new Map(),
      objects: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      nextIssue: 1,
      nextPull: 1,
      nextCommentId: 1,
      nextIssueId: 1,
      nextPullId: 1,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => b.createdSeq - a.createdSeq);
    return out;
  }

  /** Build (and store) a tree object from a flat path -> {oid, mode} map. */
  buildTreeFromFiles(
    repo: Repo,
    files: Map<string, { oid: string; mode: string }>,
  ): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of files) {
      const segs = path.split('/');
      let node = root;
      for (let i = 0; i < segs.length - 1; i++) {
        const s = segs[i]!;
        if (!node.dirs.has(s)) node.dirs.set(s, make());
        node = node.dirs.get(s)!;
      }
      node.files.set(segs[segs.length - 1]!, entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, e] of node.files) entries.push({ mode: e.mode, name, oid: e.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      const data = buildTree(entries);
      const oid = hashObject('tree', data);
      if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
      return oid;
    };
    return build(root);
  }

  /** Create a commit object on top of `parent` (null for a root commit) with the given flat file map. */
  commitFiles(
    repo: Repo,
    files: Map<string, { oid: string; mode: string }>,
    message: string,
    parent: string | null,
    timestampSec: number,
  ): string {
    const treeOid = this.buildTreeFromFiles(repo, files);
    const lines = [`tree ${treeOid}`];
    if (parent) lines.push(`parent ${parent}`);
    const who = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${timestampSec} +0000`;
    lines.push(`author ${who}`, `committer ${who}`, '');
    const data = Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
    const oid = hashObject('commit', data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'commit', data });
    return oid;
  }

  /** The flat file map at a ref tip (empty when the ref does not exist). */
  filesAt(repo: Repo, ref: string): Map<string, { oid: string; mode: string }> {
    const tip = repo.refs.get(ref);
    if (!tip) return new Map();
    const commit = repo.objects.get(tip);
    if (!commit || commit.type !== 'commit') return new Map();
    const treeOid = parseCommit(commit.data).tree;
    const flat = flattenTree(treeOid, (oid) => repo.objects.get(oid));
    const out = new Map<string, { oid: string; mode: string }>();
    for (const [path, oid] of flat) out.set(path, { oid, mode: '100644' });
    return out;
  }

  /** First common ancestor of two commits (linear-history fast path: walk both parent chains). */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsOf = (tip: string): Set<string> => {
      const seen = new Set<string>();
      const queue = [tip];
      while (queue.length) {
        const oid = queue.pop()!;
        if (seen.has(oid) || !isObjectId(oid)) continue;
        const obj = repo.objects.get(oid);
        if (!obj || obj.type !== 'commit') continue;
        seen.add(oid);
        for (const p of parseCommit(obj.data).parents) queue.push(p);
      }
      return seen;
    };
    const aSet = ancestorsOf(a);
    const queue = [b];
    const seenB = new Set<string>();
    while (queue.length) {
      const oid = queue.pop()!;
      if (seenB.has(oid) || !isObjectId(oid)) continue;
      seenB.add(oid);
      if (aSet.has(oid)) return oid;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) queue.push(p);
    }
    return null;
  }

  /** Diff between two flat file maps: {path, status, oldOid, newOid}. */
  diffFiles(
    from: Map<string, { oid: string; mode: string }>,
    to: Map<string, { oid: string; mode: string }>,
  ): { path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }[] {
    const out: { path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }[] = [];
    const paths = new Set([...from.keys(), ...to.keys()]);
    for (const path of [...paths].sort()) {
      const f = from.get(path);
      const t = to.get(path);
      if (f && !t) out.push({ path, status: 'removed', oldOid: f.oid, newOid: null });
      else if (!f && t) out.push({ path, status: 'added', oldOid: null, newOid: t.oid });
      else if (f && t && f.oid !== t.oid) out.push({ path, status: 'modified', oldOid: f.oid, newOid: t.oid });
    }
    return out;
  }

  /** Line counts for a blob diff (simple LCS over lines; blobs here are small). */
  lineDiff(repo: Repo, oldOid: string | null, newOid: string | null): { additions: number; deletions: number } {
    const text = (oid: string | null): string[] => {
      if (!oid) return [];
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'blob') return [];
      const s = obj.data.toString('utf8');
      if (s === '') return [];
      return s.split('\n');
    };
    const a = text(oldOid);
    const b = text(newOid);
    // LCS lengths
    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
    const common = dp[0]![0]!;
    return { additions: n - common, deletions: m - common };
  }

  /** The current tip of a pull request's base branch (the branch may have moved since creation). */
  baseTip(repo: Repo, pull: Pull): string {
    return repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
  }

  /** Files changed by a pull request (merge-base -> head), with line counts. */
  pullFiles(repo: Repo, pull: Pull): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
    const base = this.mergeBase(repo, pull.headSha, this.baseTip(repo, pull)) ?? pull.baseSha;
    const baseFiles = this.filesAtCommit(repo, base);
    const headFiles = this.filesAtCommit(repo, pull.headSha);
    const diff = this.diffFiles(baseFiles, headFiles);
    return diff.map((d) => {
      const { additions, deletions } = this.lineDiff(repo, d.oldOid, d.newOid);
      return {
        filename: d.path,
        status: d.status === 'removed' ? 'removed' : d.status,
        additions,
        deletions,
        changes: additions + deletions,
      };
    });
  }

  filesAtCommit(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
    const commit = repo.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return new Map();
    const treeOid = parseCommit(commit.data).tree;
    const flat = flattenTree(treeOid, (oid) => repo.objects.get(oid));
    const out = new Map<string, { oid: string; mode: string }>();
    for (const [path, oid] of flat) out.set(path, { oid, mode: '100644' });
    return out;
  }

  /** Whether a pull request can merge cleanly (no file changed on both sides with different results). */
  pullMergeable(repo: Repo, pull: Pull): boolean {
    const base = this.mergeBase(repo, pull.headSha, this.baseTip(repo, pull));
    if (base === null) return false;
    const baseFiles = this.filesAtCommit(repo, base);
    const headFiles = this.filesAtCommit(repo, pull.headSha);
    const targetFiles = this.filesAtCommit(repo, this.baseTip(repo, pull));
    const headDiff = this.diffFiles(baseFiles, headFiles);
    const targetDiff = this.diffFiles(baseFiles, targetFiles);
    const targetChanged = new Map(targetDiff.map((d) => [d.path, d.newOid]));
    for (const d of headDiff) {
      if (targetChanged.has(d.path) && targetChanged.get(d.path) !== d.newOid) return false;
    }
    return true;
  }

  /** The merged tree for a squash merge (base tree + head's changes since the merge base). */
  squashTree(repo: Repo, pull: Pull): Map<string, { oid: string; mode: string }> {
    const base = this.mergeBase(repo, pull.headSha, this.baseTip(repo, pull)) ?? pull.baseSha;
    const baseFiles = this.filesAtCommit(repo, base);
    const headFiles = this.filesAtCommit(repo, pull.headSha);
    const targetFiles = this.filesAtCommit(repo, this.baseTip(repo, pull));
    const out = new Map(targetFiles);
    for (const d of this.diffFiles(baseFiles, headFiles)) {
      if (d.status === 'removed') out.delete(d.path);
      else if (d.newOid) out.set(d.path, { oid: d.newOid, mode: '100644' });
    }
    return out;
  }

  /** All commits reachable from a tip, newest first (by traversal order, parents after children). */
  commitsFrom(repo: Repo, tip: string): { sha: string; message: string }[] {
    const out: { sha: string; message: string }[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length) {
      const oid = queue.shift()!;
      if (seen.has(oid) || !isObjectId(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      seen.add(oid);
      const c = parseCommit(obj.data);
      out.push({ sha: oid, message: c.message });
      for (const p of c.parents) queue.push(p);
    }
    return out;
  }
}

export const store = new Store();

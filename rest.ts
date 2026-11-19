// GitHub REST v3: repositories, branches, commits, contents, issues, labels, pull requests.
//
// Every reply is application/json with a non-empty X-GitHub-Request-Id. Errors carry
// {"message": string}. Auth is the trial's bearer token; a missing or wrong token is 401, and a
// repository under any owner but the token's login is 404, never 403.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  store,
  VIEWER_LOGIN,
  VIEWER_ID,
  VIEWER_NAME,
  VIEWER_EMAIL,
  DEFAULT_BRANCH,
  type Repo,
  type Issue,
  type Pull,
  hashObject,
  isObjectId,
  parseCommit,
  parseTree,
} from './store.ts';
import {
  sendJson,
  jsonError,
  parseJsonBody,
  isRecord,
  pageParams,
  paginate,
  nowIso,
  requestId,
} from './http-util.ts';

export const TOKEN: string = process.env.MAKEFUN_SHOP_TOKEN ?? '';

export function isAuthenticated(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length);
  if (token === '') return false;
  if (TOKEN === '') return true; // no token configured (local runs): any bearer token counts
  return token === TOKEN;
}

// -------------------------------------------------------------------------------------------------
// JSON shapes
// -------------------------------------------------------------------------------------------------

function userJson(): Record<string, unknown> {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: DEFAULT_BRANCH,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { id: name, name, color: label?.color ?? 'ededed' };
    }),
    user: userJson(),
    comments: issue.comments.length,
    created_at: nowIso(),
    updated_at: nowIso(),
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? store.pullMergeable(repo, pull) : false,
    user: userJson(),
    created_at: nowIso(),
    updated_at: nowIso(),
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function commentJson(comment: { id: number; body: string }): Record<string, unknown> {
  return { id: comment.id, body: comment.body, user: userJson(), created_at: nowIso(), updated_at: nowIso() };
}

// -------------------------------------------------------------------------------------------------
// contents helpers
// -------------------------------------------------------------------------------------------------

function b64encode(buf: Buffer): string {
  return buf.toString('base64');
}

function b64decode(text: string): Buffer | null {
  try {
    const clean = text.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return null;
    return Buffer.from(clean, 'base64');
  } catch {
    return null;
  }
}

interface ContentCtx {
  repo: Repo;
  branch: string;
  tip: string;
}

/** Resolve a ref name (branch) to its tip commit, or null. */
function resolveBranch(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** Walk a tree to `path` segments; returns the object (blob/tree) or null. */
function lookupPath(
  repo: Repo,
  tip: string,
  segments: string[],
): { type: 'blob' | 'tree'; oid: string; data: Buffer } | null {
  const commit = repo.objects.get(tip);
  if (!commit || commit.type !== 'commit') return null;
  let currentOid = parseCommit(commit.data).tree;
  for (let i = 0; i < segments.length; i++) {
    const obj = repo.objects.get(currentOid);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) {
      const target = repo.objects.get(entry.oid);
      if (!target) return null;
      return { type: entry.mode === '40000' ? 'tree' : 'blob', oid: entry.oid, data: target.data };
    }
    if (entry.mode !== '40000') return null;
    currentOid = entry.oid;
  }
  const root = repo.objects.get(currentOid);
  if (!root) return null;
  return { type: 'tree', oid: currentOid, data: root.data };
}

function fileContentJson(repo: Repo, path: string, blobOid: string, data: Buffer): Record<string, unknown> {
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name: path.split('/').pop() ?? path,
    path,
    sha: blobOid,
    content: b64encode(data),
  };
}

function dirEntryJson(repo: Repo, name: string, path: string, entry: { mode: string; oid: string }): Record<string, unknown> {
  const isDir = entry.mode === '40000';
  let size = 0;
  if (!isDir) {
    const obj = repo.objects.get(entry.oid);
    if (obj) size = obj.data.length;
  }
  return { type: isDir ? 'dir' : 'file', name, path, sha: entry.oid, size };
}

/** Commit a new file map on a branch; returns the new commit oid. */
function commitFileMap(
  repo: Repo,
  branch: string,
  files: Map<string, { oid: string; mode: string }>,
  message: string,
): string {
  const parent = resolveBranch(repo, branch);
  const timestampSec = Math.floor(Date.now() / 1000);
  const commitOid = store.commitFiles(repo, files, message, parent, timestampSec);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  return commitOid;
}

// -------------------------------------------------------------------------------------------------
// route handling
// -------------------------------------------------------------------------------------------------

export interface RestRequest {
  method: string;
  segments: string[]; // path segments after /api/v3/
  query: URLSearchParams;
  baseUrl: string; // origin, for Link headers
  body: unknown;
  rawBody: Buffer;
}

/** Handle one /api/v3 request. Returns true when handled. */
export function handleRest(req: IncomingMessage, res: ServerResponse, r: RestRequest): boolean {
  const [a, b, c, d, e, f] = r.segments;
  const seg = r.segments;

  // GET /api/v3/ (root) — no auth, like the starter.
  if ((r.segments.length === 0 || (r.segments.length === 1 && r.segments[0] === '')) && r.method === 'GET') {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  if (!isAuthenticated(req)) {
    jsonError(res, 401, 'Requires authentication');
    return true;
  }

  // GET /api/v3/meta
  if (a === 'meta' && seg.length === 1 && r.method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
    return true;
  }

  // GET /api/v3/user
  if (a === 'user' && seg.length === 1 && r.method === 'GET') {
    sendJson(res, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' });
    return true;
  }

  // POST /api/v3/user/repos and GET /api/v3/user/repos
  if (a === 'user' && b === 'repos' && seg.length === 2) {
    if (r.method === 'POST') return createRepo(req, res, r);
    if (r.method === 'GET') return listUserRepos(req, res, r);
    jsonError(res, 404, 'Not Found');
    return true;
  }

  // /api/v3/repos/{owner}/{name}[/...]
  if (a === 'repos' && seg.length >= 3) {
    const owner = decodeURIComponent(b ?? '');
    const name = decodeURIComponent(c ?? '');
    return handleRepoRoute(req, res, r, owner, name, seg.slice(3));
  }

  jsonError(res, 404, 'Not Found');
  return true;
}

function createRepo(_req: IncomingMessage, res: ServerResponse, r: RestRequest): boolean {
  const body = isRecord(r.body) ? r.body : {};
  const name = typeof body.name === 'string' ? body.name : '';
  if (name === '' || !/^[A-Za-z0-9._-]+$/.test(name)) {
    jsonError(res, 422, 'name is required and must be a valid repository name');
    return true;
  }
  if (store.getRepo(VIEWER_LOGIN, name)) {
    jsonError(res, 422, 'name already exists on this account');
    return true;
  }
  const repo = store.createRepo(
    VIEWER_LOGIN,
    name,
    body.private === true,
    typeof body.description === 'string' ? body.description : '',
  );
  sendJson(res, 201, repoJson(repo));
  return true;
}

function listUserRepos(_req: IncomingMessage, res: ServerResponse, r: RestRequest): boolean {
  const { perPage, page } = pageParams(r.query);
  const repos = store.listRepos(VIEWER_LOGIN);
  const { pageItems, link } = paginate(repos, perPage, page, `${r.baseUrl}/api/v3/user/repos`, r.query);
  sendJson(res, 200, pageItems.map(repoJson), link ? { link } : {});
  return true;
}

function handleRepoRoute(
  req: IncomingMessage,
  res: ServerResponse,
  r: RestRequest,
  owner: string,
  name: string,
  rest: string[],
): boolean {
  // A repository belongs to the token's login; any other owner is 404, never 403.
  if (owner !== VIEWER_LOGIN) {
    jsonError(res, 404, 'Not Found');
    return true;
  }
  const repo = store.getRepo(owner, name);

  // Repo-level: GET / PATCH / DELETE /repos/{o}/{r}
  if (rest.length === 0) {
    if (r.method === 'GET') {
      if (!repo) return jsonError(res, 404, 'Not Found'), true;
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    if (r.method === 'PATCH') {
      if (!repo) return jsonError(res, 404, 'Not Found'), true;
      const body = isRecord(r.body) ? r.body : {};
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    if (r.method === 'DELETE') {
      if (!repo) return jsonError(res, 404, 'Not Found'), true;
      store.deleteRepo(owner, name);
      res.writeHead(204, { 'x-github-request-id': requestId() });
      res.end();
      return true;
    }
    jsonError(res, 404, 'Not Found');
    return true;
  }
  if (!repo) {
    jsonError(res, 404, 'Not Found');
    return true;
  }

  const [x, y, z] = rest;

  // GET /branches, GET /branches/{branch}
  if (x === 'branches') {
    if (r.method === 'GET' && rest.length === 1) {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((branch) => ({ name: branch, commit: { sha: repo.refs.get(`refs/heads/${branch}`) }, protected: false }));
      sendJson(res, 200, branches);
      return true;
    }
    if (r.method === 'GET' && rest.length === 2) {
      const branch = decodeURIComponent(y ?? '');
      const tip = resolveBranch(repo, branch);
      if (!tip) return jsonError(res, 404, 'Not Found'), true;
      sendJson(res, 200, { name: branch, commit: { sha: tip }, protected: false });
      return true;
    }
    jsonError(res, 404, 'Not Found');
    return true;
  }

  // GET /commits[?sha=]
  if (x === 'commits' && rest.length === 1 && r.method === 'GET') {
    const shaParam = r.query.get('sha');
    let tip: string | null = null;
    if (shaParam) {
      if (isObjectId(shaParam)) tip = shaParam;
      else tip = resolveBranch(repo, shaParam);
    } else {
      tip = resolveBranch(repo, DEFAULT_BRANCH);
    }
    if (!tip || !repo.objects.has(tip)) return jsonError(res, 404, 'Not Found'), true;
    const commits = store.commitsFrom(repo, tip).map((c) => {
      const obj = repo.objects.get(c.sha)!;
      const parsed = parseCommit(obj.data);
      return {
        sha: c.sha,
        commit: {
          message: parsed.message,
          author: { name: VIEWER_NAME, email: VIEWER_EMAIL },
          committer: { name: VIEWER_NAME, email: VIEWER_EMAIL },
        },
        author: userJson(),
      };
    });
    sendJson(res, 200, commits);
    return true;
  }

  // POST /git/refs, GET /git/refs/heads/{branch}
  if (x === 'git' && y === 'refs') {
    if (r.method === 'POST' && rest.length === 2) {
      const body = isRecord(r.body) ? r.body : {};
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/heads/') || ref.length <= 'refs/heads/'.length) {
        jsonError(res, 422, 'Invalid ref');
        return true;
      }
      if (!isObjectId(sha) || !repo.objects.has(sha)) {
        jsonError(res, 422, 'Invalid sha');
        return true;
      }
      if (repo.refs.has(ref)) {
        jsonError(res, 422, 'Reference already exists');
        return true;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha, type: 'commit' } });
      return true;
    }
    if (r.method === 'GET' && rest.length === 4 && z !== undefined) {
      const branch = decodeURIComponent(rest[3]!);
      const tip = resolveBranch(repo, branch);
      if (!tip) return jsonError(res, 404, 'Not Found'), true;
      sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { sha: tip, type: 'commit' } });
      return true;
    }
    jsonError(res, 404, 'Not Found');
    return true;
  }

  // /contents/{path...}
  if (x === 'contents') {
    return handleContents(req, res, r, repo, rest.slice(1));
  }

  // /labels
  if (x === 'labels') {
    if (r.method === 'POST' && rest.length === 1) {
      const body = isRecord(r.body) ? r.body : {};
      const name2 = typeof body.name === 'string' ? body.name : '';
      const color = typeof body.color === 'string' ? body.color : 'ededed';
      if (name2 === '') return jsonError(res, 422, 'name is required'), true;
      const existing = repo.labels.get(name2);
      if (existing) {
        sendJson(res, 201, { id: name2, name: name2, color: existing.color });
        return true;
      }
      repo.labels.set(name2, { name: name2, color });
      sendJson(res, 201, { id: name2, name: name2, color });
      return true;
    }
    if (r.method === 'GET' && rest.length === 1) {
      sendJson(res, 200, [...repo.labels.values()].map((l) => ({ id: l.name, name: l.name, color: l.color })));
      return true;
    }
    jsonError(res, 404, 'Not Found');
    return true;
  }

  // /issues...
  if (x === 'issues') {
    return handleIssues(req, res, r, repo, rest.slice(1));
  }

  // /pulls...
  if (x === 'pulls') {
    return handlePulls(req, res, r, repo, rest.slice(1));
  }

  jsonError(res, 404, 'Not Found');
  return true;
}

function handleContents(
  _req: IncomingMessage,
  res: ServerResponse,
  r: RestRequest,
  repo: Repo,
  pathSegs: string[],
): boolean {
  const path = pathSegs.map((s) => decodeURIComponent(s)).join('/');
  const ref = r.query.get('ref') ?? DEFAULT_BRANCH;

  if (r.method === 'GET') {
    const tip = resolveBranch(repo, ref);
    if (!tip) return jsonError(res, 404, 'Not Found'), true;
    if (path === '') {
      // Root listing.
      const commit = repo.objects.get(tip);
      if (!commit || commit.type !== 'commit') return jsonError(res, 404, 'Not Found'), true;
      const root = repo.objects.get(parseCommit(commit.data).tree);
      if (!root) return jsonError(res, 404, 'Not Found'), true;
      const entries = parseTree(root.data).map((e) => dirEntryJson(repo, e.name, e.name, e));
      sendJson(res, 200, entries);
      return true;
    }
    const found = lookupPath(repo, tip, path.split('/'));
    if (!found) return jsonError(res, 404, 'Not Found'), true;
    if (found.type === 'blob') {
      sendJson(res, 200, fileContentJson(repo, path, found.oid, found.data));
      return true;
    }
    const entries = parseTree(found.data).map((e) => dirEntryJson(repo, e.name, `${path}/${e.name}`, e));
    sendJson(res, 200, entries);
    return true;
  }

  if (r.method === 'PUT') {
    const body = isRecord(r.body) ? r.body : {};
    const message = typeof body.message === 'string' ? body.message : 'Update file';
    const contentB64 = typeof body.content === 'string' ? body.content : '';
    const content = b64decode(contentB64);
    if (content === null) return jsonError(res, 400, 'content is not valid base64'), true;
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : DEFAULT_BRANCH;
    const sha = typeof body.sha === 'string' ? body.sha : null;
    let tip = resolveBranch(repo, branch);
    if (!tip) {
      // Create the branch from the default branch tip (or as the root when the repo is unborn).
      const base = resolveBranch(repo, DEFAULT_BRANCH);
      if (base) repo.refs.set(`refs/heads/${branch}`, base);
      tip = resolveBranch(repo, branch);
    }
    const files = store.filesAt(repo, `refs/heads/${branch}`);
    const existing = files.get(path);
    if (existing) {
      if (sha === null) return jsonError(res, 422, 'sha is required to update a file'), true;
      if (sha.toLowerCase() !== existing.oid.toLowerCase()) return jsonError(res, 409, 'sha does not match the current file'), true;
    } else if (sha !== null) {
      return jsonError(res, 409, 'sha does not match the current file'), true;
    }
    const blobOid = hashObject('blob', content);
    if (!repo.objects.has(blobOid)) repo.objects.set(blobOid, { type: 'blob', data: content });
    const next = new Map(files);
    next.set(path, { oid: blobOid, mode: '100644' });
    const commitOid = commitFileMap(repo, branch, next, message);
    sendJson(res, existing ? 200 : 201, {
      content: fileContentJson(repo, path, blobOid, content),
      commit: { sha: commitOid, message },
    });
    return true;
  }

  if (r.method === 'DELETE') {
    const body = isRecord(r.body) ? r.body : {};
    const message = typeof body.message === 'string' ? body.message : 'Delete file';
    const sha = typeof body.sha === 'string' ? body.sha : null;
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : DEFAULT_BRANCH;
    const tip = resolveBranch(repo, branch);
    if (!tip) return jsonError(res, 404, 'Not Found'), true;
    const files = store.filesAt(repo, `refs/heads/${branch}`);
    const existing = files.get(path);
    if (!existing) return jsonError(res, 404, 'Not Found'), true;
    if (sha === null) return jsonError(res, 422, 'sha is required to delete a file'), true;
    if (sha.toLowerCase() !== existing.oid.toLowerCase()) return jsonError(res, 409, 'sha does not match the current file'), true;
    const next = new Map(files);
    next.delete(path);
    const commitOid = commitFileMap(repo, branch, next, message);
    sendJson(res, 200, { commit: { sha: commitOid, message } });
    return true;
  }

  jsonError(res, 404, 'Not Found');
  return true;
}

function handleIssues(
  _req: IncomingMessage,
  res: ServerResponse,
  r: RestRequest,
  repo: Repo,
  rest: string[],
): boolean {
  // POST /issues, GET /issues
  if (rest.length === 0) {
    if (r.method === 'POST') {
      const body = isRecord(r.body) ? r.body : {};
      const title = typeof body.title === 'string' ? body.title : '';
      if (title === '') return jsonError(res, 422, 'title is required'), true;
      const labels: string[] = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return jsonError(res, 422, `Label does not exist: ${label}`), true;
      }
      const issue: Issue = {
        id: store.globalId(),
        number: repo.nextIssue++,
        title,
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open',
        labels,
        createdSeq: store.seq(),
        comments: [],
      };
      repo.issues.push(issue);
      sendJson(res, 201, issueJson(repo, issue));
      return true;
    }
    if (r.method === 'GET') {
      const state = r.query.get('state') ?? 'open';
      const sort = r.query.get('sort') ?? 'created';
      const direction = r.query.get('direction') ?? 'desc';
      let list = [...repo.issues];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      if (sort === 'created') {
        list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      }
      const { perPage, page } = pageParams(r.query);
      const { pageItems, link } = paginate(list, perPage, page, `${r.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/issues`, r.query);
      sendJson(res, 200, pageItems.map((i) => issueJson(repo, i)), link ? { link } : {});
      return true;
    }
    jsonError(res, 404, 'Not Found');
    return true;
  }

  const number = Number(rest[0]);
  const issue = repo.issues.find((i) => i.number === number);
  if (!issue) return jsonError(res, 404, 'Not Found'), true;

  // GET /issues/{n}, PATCH /issues/{n}
  if (rest.length === 1) {
    if (r.method === 'GET') {
      sendJson(res, 200, issueJson(repo, issue));
      return true;
    }
    if (r.method === 'PATCH') {
      const body = isRecord(r.body) ? r.body : {};
      if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      sendJson(res, 200, issueJson(repo, issue));
      return true;
    }
    jsonError(res, 404, 'Not Found');
    return true;
  }

  // /issues/{n}/comments
  if (rest[1] === 'comments' && rest.length === 2) {
    if (r.method === 'POST') {
      const body = isRecord(r.body) ? r.body : {};
      const text = typeof body.body === 'string' ? body.body : '';
      if (text === '') return jsonError(res, 422, 'body is required'), true;
      const comment = { id: repo.nextCommentId++, body: text, createdSeq: store.seq() };
      issue.comments.push(comment);
      sendJson(res, 201, commentJson(comment));
      return true;
    }
    if (r.method === 'GET') {
      sendJson(res, 200, issue.comments.map(commentJson));
      return true;
    }
  }

  jsonError(res, 404, 'Not Found');
  return true;
}

function handlePulls(
  _req: IncomingMessage,
  res: ServerResponse,
  r: RestRequest,
  repo: Repo,
  rest: string[],
): boolean {
  // POST /pulls, GET /pulls
  if (rest.length === 0) {
    if (r.method === 'POST') {
      const body = isRecord(r.body) ? r.body : {};
      const title = typeof body.title === 'string' ? body.title : '';
      const head = typeof body.head === 'string' ? body.head : '';
      const base = typeof body.base === 'string' ? body.base : '';
      if (title === '' || head === '' || base === '') return jsonError(res, 422, 'title, head and base are required'), true;
      const headSha = resolveBranch(repo, head);
      const baseSha = resolveBranch(repo, base);
      if (!headSha || !baseSha) return jsonError(res, 422, 'head or base branch does not exist'), true;
      const existing = repo.pulls.find((p) => p.head === head && p.state === 'open');
      if (existing) return jsonError(res, 422, 'A pull request already exists for this head branch'), true;
      const pull: Pull = {
        id: store.globalId(),
        number: repo.nextPull++,
        title,
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        head,
        base,
        headSha,
        baseSha,
        createdSeq: store.seq(),
      };
      repo.pulls.push(pull);
      sendJson(res, 201, pullJson(repo, pull));
      return true;
    }
    if (r.method === 'GET') {
      const state = r.query.get('state') ?? 'open';
      let list = [...repo.pulls];
      if (state !== 'all') list = list.filter((p) => p.state === state);
      list.sort((a, b) => b.createdSeq - a.createdSeq);
      const { perPage, page } = pageParams(r.query);
      const { pageItems, link } = paginate(list, perPage, page, `${r.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/pulls`, r.query);
      sendJson(res, 200, pageItems.map((p) => pullJson(repo, p)), link ? { link } : {});
      return true;
    }
    jsonError(res, 404, 'Not Found');
    return true;
  }

  const number = Number(rest[0]);
  const pull = repo.pulls.find((p) => p.number === number);
  if (!pull) return jsonError(res, 404, 'Not Found'), true;

  // GET /pulls/{n}
  if (rest.length === 1 && r.method === 'GET') {
    sendJson(res, 200, pullJson(repo, pull));
    return true;
  }

  // GET /pulls/{n}/files
  if (rest.length === 2 && rest[1] === 'files' && r.method === 'GET') {
    sendJson(res, 200, store.pullFiles(repo, pull));
    return true;
  }

  // PUT /pulls/{n}/merge
  if (rest.length === 2 && rest[1] === 'merge' && r.method === 'PUT') {
    if (pull.merged || pull.state !== 'open') {
      jsonError(res, 405, 'Pull request is already merged or closed');
      return true;
    }
    if (!store.pullMergeable(repo, pull)) {
      jsonError(res, 405, 'Merge conflict');
      return true;
    }
    const files = store.squashTree(repo, pull);
    const baseTip = resolveBranch(repo, pull.base)!;
    const timestampSec = Math.floor(Date.now() / 1000);
    const message = `Merge pull request #${pull.number} from ${pull.head}`;
    const mergeOid = store.commitFiles(repo, files, message, baseTip, timestampSec);
    repo.refs.set(`refs/heads/${pull.base}`, mergeOid);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = nowIso();
    pull.mergeCommitSha = mergeOid;
    sendJson(res, 200, { merged: true, sha: mergeOid, message: 'Pull request successfully merged' });
    return true;
  }

  jsonError(res, 404, 'Not Found');
  return true;
}

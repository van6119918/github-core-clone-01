// GitHub GraphQL v4, for the documents gh and github-mcp-server actually send.
// A small parser + executor over the in-memory store. No schema is advertised beyond the
// __type introspection the feature probes need; an unknown field is HTTP 200 with an errors
// array naming it, never an HTTP 400.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  store,
  VIEWER_LOGIN,
  VIEWER_ID,
  DEFAULT_BRANCH,
  type Repo,
  type Issue,
  type Pull,
} from './store.ts';
import { sendJson, jsonError, isRecord } from './http-util.ts';
import { isAuthenticated } from './rest.ts';

// -------------------------------------------------------------------------------------------------
// global ids (opaque, stable): base64url of "kind:..." — never the plain database id or number
// -------------------------------------------------------------------------------------------------

function gid(kind: string, parts: (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64url');
}

function ungid(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function numberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------------------------------
// parser
// -------------------------------------------------------------------------------------------------

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: { name: string; value: Value }[] };

interface Selection {
  alias: string | null;
  name: string;
  args: { name: string; value: Value }[];
  selections: Selection[] | null;
  fragmentType: string | null; // for inline fragments: the type condition
}

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  variables: string[]; // variable names
  selections: Selection[];
}

class ParseError extends Error {}

function tokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch) || ch === ',') {
      i++;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '.' && src.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}():!=$[]@'.includes(ch)) {
      tokens.push(ch);
      i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j]!)) j++;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    throw new ParseError(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private tokens: string[];
  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }
  private next(): string {
    const t = this.tokens[this.pos];
    if (t === undefined) throw new ParseError('unexpected end of document');
    this.pos++;
    return t;
  }
  private expect(t: string): void {
    const got = this.next();
    if (got !== t) throw new ParseError(`expected ${t}, got ${got}`);
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.pos < this.tokens.length) {
      ops.push(this.parseOperation());
    }
    return ops;
  }

  private parseOperation(): Operation {
    let type: 'query' | 'mutation' = 'query';
    const tok = this.peek();
    if (tok === 'query' || tok === 'mutation') {
      type = this.next() as 'query' | 'mutation';
    }
    let name: string | null = null;
    const maybeName = this.peek();
    if (maybeName !== undefined && maybeName !== '(' && maybeName !== '{' && !maybeName.startsWith('"')) {
      name = this.next();
    }
    const variables: string[] = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const dollar = this.next();
        if (dollar !== '$') throw new ParseError('expected $ in variable definition');
        variables.push(this.next());
        this.expect(':');
        this.parseType();
        if (this.peek() === '=') {
          this.next();
          this.parseValue();
        }
      }
      this.expect(')');
    }
    const selections = this.parseSelectionSet();
    return { type, name, variables, selections };
  }

  private parseType(): void {
    if (this.peek() === '[') {
      this.next();
      this.parseType();
      this.expect(']');
    } else {
      this.next();
    }
    if (this.peek() === '!') this.next();
  }

  private parseSelectionSet(): Selection[] {
    this.expect('{');
    const out: Selection[] = [];
    while (this.peek() !== '}') {
      out.push(this.parseSelection());
    }
    this.expect('}');
    return out;
  }

  private parseSelection(): Selection {
    if (this.peek() === '...') {
      this.next();
      let fragmentType: string | null = null;
      if (this.peek() === 'on') {
        this.next();
        fragmentType = this.next();
      } else {
        // Named fragment spread: not used by the suite; skip its name.
        this.next();
        return { alias: null, name: '', args: [], selections: null, fragmentType };
      }
      const selections = this.parseSelectionSet();
      return { alias: null, name: '', args: [], selections, fragmentType };
    }
    let alias: string | null = null;
    let name = this.next();
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: { name: string; value: Value }[] = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expect(')');
    }
    let selections: Selection[] | null = null;
    if (this.peek() === '{') selections = this.parseSelectionSet();
    return { alias, name, args, selections, fragmentType: null };
  }

  private parseValue(): Value {
    const tok = this.next();
    if (tok === '$') return { kind: 'variable', name: this.next() };
    if (tok === '[') {
      const values: Value[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (tok === '{') {
      const fields: { name: string; value: Value }[] = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (tok.startsWith('"')) return { kind: 'string', value: JSON.parse(tok) as string };
    if (tok === 'true') return { kind: 'boolean', value: true };
    if (tok === 'false') return { kind: 'boolean', value: false };
    if (tok === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(tok)) return { kind: 'int', value: Number(tok) };
    if (/^-?\d*\.\d+([eE][+-]?\d+)?$/.test(tok)) return { kind: 'float', value: Number(tok) };
    return { kind: 'enum', value: tok };
  }
}

// -------------------------------------------------------------------------------------------------
// execution
// -------------------------------------------------------------------------------------------------

interface GqlContext {
  errors: { message: string }[];
  variables: Record<string, unknown>;
}

type GqlValue = Record<string, unknown> | null;

function resolveValue(value: Value, ctx: GqlContext): unknown {
  switch (value.kind) {
    case 'variable':
      return ctx.variables[value.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((v) => resolveValue(v, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of value.fields) out[f.name] = resolveValue(f.value, ctx);
      return out;
    }
  }
}

function argsOf(sel: Selection, ctx: GqlContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of sel.args) out[a.name] = resolveValue(a.value, ctx);
  return out;
}

// The schema: which fields each type holds (for validation and introspection).
const SCHEMA_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  User: ['id', 'login', 'name', 'email', 'avatarUrl', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate',
    'createdAt', 'updatedAt', 'url', 'stargazerCount', 'forkCount',
  ],
  Ref: ['name', 'target'],
  Issue: [
    'id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'url', 'author',
    'comments', 'labels', 'closedAt', 'assignees', 'milestone', 'repository',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRefOid', 'baseRefOid', 'files', 'commits', 'reviews', 'author', 'createdAt', 'updatedAt',
    'url', 'additions', 'deletions', 'changedFiles', 'repository',
  ],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  IssueCommentEdge: ['node', 'cursor'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'];

interface Obj {
  __typename: string;
  [key: string]: unknown;
}

function userObj(): Obj {
  return { __typename: 'User', login: VIEWER_LOGIN, id: gid('user', [VIEWER_ID]) };
}

function repoObj(repo: Repo): Obj {
  return { __typename: 'Repository', __repo: repo, id: gid('repo', [repo.id]), databaseId: repo.id, name: repo.name };
}

function issueObj(repo: Repo, issue: Issue): Obj {
  return {
    __typename: 'Issue',
    __repo: repo,
    __issue: issue,
    id: gid('issue', [repo.id, issue.number]),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
  };
}

function pullObj(repo: Repo, pull: Pull): Obj {
  return {
    __typename: 'PullRequest',
    __repo: repo,
    __pull: pull,
    id: gid('pull', [repo.id, pull.number]),
    number: pull.number,
    title: pull.title,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    headRefName: pull.head,
    baseRefName: pull.base,
  };
}

function findRepoById(dbId: number): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.id === dbId) return repo;
  return undefined;
}

/** Resolve one field of an object; returns the raw value (scalar, object, or array). */
function resolveField(obj: Obj, field: string, args: Record<string, unknown>, ctx: GqlContext): unknown {
  const typename = obj.__typename;
  switch (typename) {
    case 'Query': {
      if (field === 'viewer') return userObj();
      if (field === 'repository') {
        const owner = args.owner as string;
        const name = args.name as string;
        if (owner !== VIEWER_LOGIN) return null;
        const repo = store.getRepo(owner, name);
        return repo ? repoObj(repo) : null;
      }
      if (field === 'node') {
        const id = args.id as string;
        const decoded = ungid(id);
        if (!decoded) return null;
        if (decoded.kind === 'repo') {
          const repo = findRepoById(Number(decoded.parts[0]));
          return repo ? repoObj(repo) : null;
        }
        if (decoded.kind === 'issue') {
          const repo = findRepoById(Number(decoded.parts[0]));
          const issue = repo?.issues.find((i) => i.number === Number(decoded.parts[1]));
          return repo && issue ? issueObj(repo, issue) : null;
        }
        if (decoded.kind === 'pull') {
          const repo = findRepoById(Number(decoded.parts[0]));
          const pull = repo?.pulls.find((p) => p.number === Number(decoded.parts[1]));
          return repo && pull ? pullObj(repo, pull) : null;
        }
        return null;
      }
      if (field === '__type') {
        const name = args.name as string;
        if (name === 'SearchType') {
          return { __typename: '__Type', name, fields: null, enumValues: SEARCH_TYPE_VALUES.map((n) => ({ __typename: '__EnumValue', name: n })) };
        }
        const fields = SCHEMA_FIELDS[name];
        if (!fields) return null;
        return { __typename: '__Type', name, fields: fields.map((n) => ({ __typename: '__Field', name: n })), enumValues: null };
      }
      return undefined;
    }
    case 'User': {
      if (field === 'login') return obj.login;
      if (field === 'id') return obj.id;
      if (field === 'name') return VIEWER_LOGIN;
      return null;
    }
    case 'Repository': {
      const repo = obj.__repo as Repo;
      if (field === 'id') return obj.id;
      if (field === 'databaseId') return repo.id;
      if (field === 'name') return repo.name;
      if (field === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (field === 'owner') return userObj();
      if (field === 'defaultBranchRef') {
        const tip = repo.refs.get('refs/heads/main');
        return tip ? { __typename: 'Ref', name: DEFAULT_BRANCH } : null;
      }
      if (field === 'viewerPermission') return 'ADMIN';
      if (field === 'hasIssuesEnabled') return true;
      if (field === 'description') return repo.description;
      if (field === 'isPrivate') return repo.isPrivate;
      if (field === 'issue') {
        const number = args.number as number;
        const issue = repo.issues.find((i) => i.number === number);
        return issue ? issueObj(repo, issue) : null;
      }
      if (field === 'issues') return issuesConnection(repo, args);
      if (field === 'pullRequests') {
        const first = args.first as number | undefined;
        let pulls = [...repo.pulls].sort((a, b) => a.number - b.number);
        if (typeof first === 'number') pulls = pulls.slice(0, first);
        return { __typename: 'PullRequestConnection', __nodes: pulls.map((p) => pullObj(repo, p)) };
      }
      if (field === 'pullRequest') {
        const number = args.number as number;
        const pull = repo.pulls.find((p) => p.number === number);
        return pull ? pullObj(repo, pull) : null;
      }
      return null;
    }
    case 'Ref': {
      if (field === 'name') return obj.name;
      return null;
    }
    case 'Issue': {
      const issue = obj.__issue as Issue;
      if (field === 'id') return obj.id;
      if (field === 'number') return issue.number;
      if (field === 'title') return issue.title;
      if (field === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field === 'body') return issue.body;
      return null;
    }
    case 'IssueConnection': {
      if (field === 'nodes') return (obj.__nodes as Obj[]) ?? [];
      if (field === 'pageInfo') return obj.__pageInfo ?? { __typename: 'PageInfo', hasNextPage: false, endCursor: null };
      if (field === 'totalCount') return (obj.__nodes as Obj[] | undefined)?.length ?? 0;
      return null;
    }
    case 'PageInfo': {
      if (field === 'hasNextPage') return obj.hasNextPage ?? false;
      if (field === 'hasPreviousPage') return obj.hasPreviousPage ?? false;
      if (field === 'endCursor') return obj.endCursor ?? null;
      if (field === 'startCursor') return obj.startCursor ?? null;
      return null;
    }
    case 'PullRequest': {
      const repo = obj.__repo as Repo;
      const pull = obj.__pull as Pull;
      if (field === 'id') return obj.id;
      if (field === 'number') return pull.number;
      if (field === 'title') return pull.title;
      if (field === 'body') return pull.body;
      if (field === 'state') return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field === 'merged') return pull.merged;
      if (field === 'headRefName') return pull.head;
      if (field === 'baseRefName') return pull.base;
      if (field === 'mergeable') {
        if (pull.state !== 'open') return 'UNKNOWN';
        return store.pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
      }
      if (field === 'files') {
        const first = args.first as number | undefined;
        let files = store.pullFiles(repo, pull).map((f) => ({ __typename: 'PullRequestChangedFile', path: f.filename }));
        if (typeof first === 'number') files = files.slice(0, first);
        return { __typename: 'PullRequestChangedFileConnection', __nodes: files };
      }
      return null;
    }
    case 'PullRequestConnection': {
      if (field === 'nodes') return (obj.__nodes as Obj[]) ?? [];
      if (field === 'pageInfo') return { __typename: 'PageInfo', hasNextPage: false, endCursor: null };
      if (field === 'totalCount') return (obj.__nodes as Obj[] | undefined)?.length ?? 0;
      return null;
    }
    case 'PullRequestChangedFileConnection': {
      if (field === 'nodes') return (obj.__nodes as Obj[]) ?? [];
      if (field === 'pageInfo') return { __typename: 'PageInfo', hasNextPage: false, endCursor: null };
      return null;
    }
    case 'PullRequestChangedFile': {
      if (field === 'path') return obj.path;
      return null;
    }
    case '__Type': {
      if (field === 'name') return obj.name;
      if (field === 'fields') return (obj.fields as { name: string }[] | null) ?? null;
      if (field === 'enumValues') return (obj.enumValues as { name: string }[] | null) ?? null;
      return null;
    }
    case 'Mutation': {
      return resolveMutation(field, args, ctx);
    }
    default:
      // Payload wrappers (CreateIssuePayload, AddCommentPayload, ...), introspection
      // entries (__Field, __EnumValue) and comments: plain property lookup.
      return (obj as Record<string, unknown>)[field] ?? null;
  }
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): Obj {
  const states = args.states as string[] | undefined;
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const first = args.first as number | undefined;
  const after = args.after as string | null | undefined;
  let list = [...repo.issues];
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  const direction = orderBy?.direction === 'DESC' ? -1 : 1;
  list.sort((a, b) => {
    const bySeq = (a.createdSeq - b.createdSeq) * direction;
    if (bySeq !== 0) return bySeq;
    return (a.number - b.number) * direction;
  });
  let start = 0;
  if (typeof after === 'string' && after !== '') {
    const afterNumber = numberFromCursor(after);
    if (afterNumber !== null) {
      const idx = list.findIndex((i) => i.number === afterNumber);
      if (idx >= 0) start = idx + 1;
    }
  }
  const sliced = typeof first === 'number' ? list.slice(start, start + first) : list.slice(start);
  const hasNextPage = start + sliced.length < list.length;
  const endCursor = sliced.length ? cursorFor(sliced[sliced.length - 1]!.number) : null;
  return {
    __typename: 'IssueConnection',
    __nodes: sliced.map((i) => issueObj(repo, i)),
    __pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
  };
}

function resolveMutation(field: string, args: Record<string, unknown>, _ctx: GqlContext): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  if (field === 'createIssue') {
    const repoId = ungid(String(input.repositoryId ?? ''));
    const repo = repoId?.kind === 'repo' ? findRepoById(Number(repoId.parts[0])) : undefined;
    if (!repo) throw new Error('repository not found');
    const issue: Issue = {
      id: store.globalId(),
      number: repo.nextIssue++,
      title: String(input.title ?? ''),
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      labels: [],
      createdSeq: store.seq(),
      comments: [],
    };
    repo.issues.push(issue);
    return { __typename: 'CreateIssuePayload', issue: issueObj(repo, issue) };
  }
  if (field === 'closeIssue') {
    const decoded = ungid(String(input.issueId ?? ''));
    const repo = decoded?.kind === 'issue' ? findRepoById(Number(decoded.parts[0])) : undefined;
    const issue = repo?.issues.find((i) => i.number === Number(decoded?.parts[1]));
    if (!repo || !issue) throw new Error('issue not found');
    issue.state = 'closed';
    return { __typename: 'CloseIssuePayload', issue: issueObj(repo, issue) };
  }
  if (field === 'createPullRequest') {
    const repoId = ungid(String(input.repositoryId ?? ''));
    const repo = repoId?.kind === 'repo' ? findRepoById(Number(repoId.parts[0])) : undefined;
    if (!repo) throw new Error('repository not found');
    const head = String(input.headRefName ?? '');
    const base = String(input.baseRefName ?? '');
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha || !baseSha) throw new Error('head or base branch does not exist');
    const pull: Pull = {
      id: store.globalId(),
      number: repo.nextPull++,
      title: String(input.title ?? ''),
      body: typeof input.body === 'string' ? input.body : '',
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
    return { __typename: 'CreatePullRequestPayload', pullRequest: pullObj(repo, pull) };
  }
  if (field === 'mergePullRequest') {
    const decoded = ungid(String(input.pullRequestId ?? ''));
    const repo = decoded?.kind === 'pull' ? findRepoById(Number(decoded.parts[0])) : undefined;
    const pull = repo?.pulls.find((p) => p.number === Number(decoded?.parts[1]));
    if (!repo || !pull) throw new Error('pull request not found');
    if (pull.state !== 'open' || !store.pullMergeable(repo, pull)) throw new Error('pull request cannot be merged');
    const files = store.squashTree(repo, pull);
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`)!;
    const mergeOid = store.commitFiles(repo, files, `Merge pull request #${pull.number} from ${pull.head}`, baseTip, Math.floor(Date.now() / 1000));
    repo.refs.set(`refs/heads/${pull.base}`, mergeOid);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = new Date().toISOString();
    pull.mergeCommitSha = mergeOid;
    return { __typename: 'MergePullRequestPayload', pullRequest: pullObj(repo, pull) };
  }
  if (field === 'addComment') {
    const decoded = ungid(String(input.subjectId ?? ''));
    const repo = decoded?.kind === 'issue' ? findRepoById(Number(decoded.parts[0])) : undefined;
    const issue = repo?.issues.find((i) => i.number === Number(decoded?.parts[1]));
    if (!repo || !issue) throw new Error('issue not found');
    const comment = { id: repo.nextCommentId++, body: String(input.body ?? ''), createdSeq: store.seq() };
    issue.comments.push(comment);
    return {
      __typename: 'AddCommentPayload',
      commentEdge: {
        __typename: 'IssueCommentEdge',
        node: { __typename: 'IssueComment', id: gid('comment', [comment.id]), body: comment.body },
      },
    };
  }
  return undefined;
}

/** Execute one operation document against the store. */
function executeOperation(op: Operation, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors: { message: string }[] } {
  const ctx: GqlContext = { errors: [], variables };
  const rootType = op.type === 'mutation' ? 'Mutation' : 'Query';
  const root: Obj = { __typename: rootType };
  const data: Record<string, unknown> = {};
  for (const sel of op.selections) {
    const key = sel.alias ?? sel.name;
    try {
      data[key] = executeSelection(root, sel, ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      data[key] = null;
    }
  }
  return { data, errors: ctx.errors };
}

function executeSelection(obj: Obj, sel: Selection, ctx: GqlContext): unknown {
  // Inline fragment: apply only when the type matches.
  if (sel.fragmentType !== null) {
    if (obj.__typename !== sel.fragmentType) return undefined;
    const out: Record<string, unknown> = {};
    for (const sub of sel.selections ?? []) {
      const key = sub.alias ?? sub.name;
      const value = executeSelection(obj, sub, ctx);
      if (value !== undefined) out[key] = value;
    }
    return out;
  }
  const field = sel.name;
  if (field === '__typename') return obj.__typename;
  const known = SCHEMA_FIELDS[obj.__typename];
  if (known && !known.includes(field)) {
    ctx.errors.push({ message: `Cannot query field "${field}" on type "${obj.__typename}".` });
    return null;
  }
  const args = argsOf(sel, ctx);
  let value: unknown;
  try {
    value = resolveField(obj, field, args, ctx);
  } catch (err) {
    ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
    return null;
  }
  if (value === undefined) {
    ctx.errors.push({ message: `Cannot query field "${field}" on type "${obj.__typename}".` });
    return null;
  }
  if (sel.selections === null || sel.selections.length === 0) return value;
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map((entry) => executeOnValue(entry, sel.selections!, ctx));
  }
  return executeOnValue(value, sel.selections, ctx);
}

function executeOnValue(value: unknown, selections: Selection[], ctx: GqlContext): unknown {
  if (value === null || typeof value !== 'object') return value;
  const obj = value as Obj;
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    // A fragment selection merges its fields into this object.
    if (sel.fragmentType !== null) {
      if (obj.__typename !== sel.fragmentType) continue;
      for (const sub of sel.selections ?? []) {
        const key = sub.alias ?? sub.name;
        const v = executeSelection(obj, sub, ctx);
        if (v !== undefined) out[key] = v;
      }
      continue;
    }
    const key = sel.alias ?? sel.name;
    const v = executeSelection(obj, sel, ctx);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// HTTP entry point
// -------------------------------------------------------------------------------------------------

export async function handleGraphql(req: IncomingMessage, res: ServerResponse, rawBody: Buffer): Promise<boolean> {
  if (!isAuthenticated(req)) {
    jsonError(res, 401, 'Requires authentication');
    return true;
  }
  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 200, { errors: [{ message: 'Unexpected token in JSON' }] });
    return true;
  }
  const runOne = (doc: unknown): Record<string, unknown> => {
    if (!isRecord(doc) || typeof doc.query !== 'string') {
      return { errors: [{ message: 'A GraphQL document with a query string is required.' }] };
    }
    const variables = isRecord(doc.variables) ? (doc.variables as Record<string, unknown>) : {};
    let operations: Operation[];
    try {
      operations = new Parser(tokenize(doc.query)).parseDocument();
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    if (operations.length === 0) return { errors: [{ message: 'Empty GraphQL document.' }] };
    const op = operations[0]!;
    const { data, errors } = executeOperation(op, variables);
    const out: Record<string, unknown> = { data };
    if (errors.length) out.errors = errors;
    return out;
  };
  if (Array.isArray(body)) {
    sendJson(res, 200, body.map(runOne));
    return true;
  }
  sendJson(res, 200, runOne(body));
  return true;
}

// MCP endpoint (POST /mcp), streamable HTTP over JSON-RPC 2.0.
// Both eras are supported: the modern 2026-07-28 discovery handshake and the legacy
// initialize handshake. tools/list returns a fixed constant array (byte-identical across
// calls); tools/call requires the bearer token, which tools/list and the handshake do not.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  store,
  VIEWER_LOGIN,
  type Issue,
  type Pull,
} from './store.ts';
import { sendJson, jsonError, isRecord, nowIso } from './http-util.ts';
import { isAuthenticated } from './rest.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const MODERN_VERSION = '2026-07-28';
const LEGACY_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        head: { type: 'string', description: 'The name of the branch where the changes are implemented.' },
        base: { type: 'string', description: 'The name of the branch you want the changes pulled into.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'number', description: 'The number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function rpcResult(res: ServerResponse, id: unknown, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id, result });
}

function rpcError(res: ServerResponse, id: unknown, code: number, message: string): void {
  sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
}

function toolErrorResult(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

function toolOkResult(payload: unknown): Record<string, unknown> {
  const text = JSON.stringify(payload);
  return {
    content: [{ type: 'text', text }],
    structuredContent: payload,
  };
}

function requireString(args: Record<string, unknown>, key: string): string | null {
  const v = args[key];
  return typeof v === 'string' && v !== '' ? v : null;
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = requireString(args, 'name');
      if (!repoName) return toolErrorResult('name is required');
      if (store.getRepo(VIEWER_LOGIN, repoName)) return toolErrorResult('name already exists on this account');
      const repo = store.createRepo(
        VIEWER_LOGIN,
        repoName,
        args.private === true,
        typeof args.description === 'string' ? args.description : '',
      );
      return toolOkResult({
        id: repo.id,
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        owner: { login: VIEWER_LOGIN },
        private: repo.isPrivate,
        description: repo.description,
        default_branch: 'main',
      });
    }
    case 'get_repo': {
      const owner = requireString(args, 'owner');
      const repoName = requireString(args, 'repo');
      if (!owner || !repoName) return toolErrorResult('owner and repo are required');
      if (owner !== VIEWER_LOGIN) return toolErrorResult('Not Found');
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolErrorResult('Not Found');
      return toolOkResult({
        id: repo.id,
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        owner: { login: VIEWER_LOGIN },
        private: repo.isPrivate,
        description: repo.description,
        default_branch: 'main',
      });
    }
    case 'create_issue': {
      const owner = requireString(args, 'owner');
      const repoName = requireString(args, 'repo');
      const title = requireString(args, 'title');
      if (!owner || !repoName || !title) return toolErrorResult('owner, repo and title are required');
      if (owner !== VIEWER_LOGIN) return toolErrorResult('Not Found');
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolErrorResult('Not Found');
      const issue: Issue = {
        id: store.globalId(),
        number: repo.nextIssue++,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        createdSeq: store.seq(),
        comments: [],
      };
      repo.issues.push(issue);
      return toolOkResult({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: [],
        user: { login: VIEWER_LOGIN },
        created_at: nowIso(),
      });
    }
    case 'list_issues': {
      const owner = requireString(args, 'owner');
      const repoName = requireString(args, 'repo');
      if (!owner || !repoName) return toolErrorResult('owner and repo are required');
      if (owner !== VIEWER_LOGIN) return toolErrorResult('Not Found');
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolErrorResult('Not Found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      return toolOkResult({
        issues: list.map((i) => ({
          id: i.id,
          number: i.number,
          title: i.title,
          body: i.body,
          state: i.state,
          labels: i.labels,
          user: { login: VIEWER_LOGIN },
          created_at: nowIso(),
        })),
      });
    }
    case 'create_pull_request': {
      const owner = requireString(args, 'owner');
      const repoName = requireString(args, 'repo');
      const title = requireString(args, 'title');
      const head = requireString(args, 'head');
      const base = requireString(args, 'base');
      if (!owner || !repoName || !title || !head || !base) {
        return toolErrorResult('owner, repo, title, head and base are required');
      }
      if (owner !== VIEWER_LOGIN) return toolErrorResult('Not Found');
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolErrorResult('Not Found');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return toolErrorResult('head or base branch does not exist');
      if (repo.pulls.some((p) => p.head === head && p.state === 'open')) {
        return toolErrorResult('A pull request already exists for this head branch');
      }
      const pull: Pull = {
        id: store.globalId(),
        number: repo.nextPull++,
        title,
        body: typeof args.body === 'string' ? args.body : '',
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
      return toolOkResult({
        id: pull.id,
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        head: { ref: pull.head, sha: pull.headSha },
        base: { ref: pull.base, sha: pull.baseSha },
        merged: false,
        user: { login: VIEWER_LOGIN },
        created_at: nowIso(),
      });
    }
    case 'merge_pull_request': {
      const owner = requireString(args, 'owner');
      const repoName = requireString(args, 'repo');
      const pullNumber = args.pull_number;
      if (!owner || !repoName || typeof pullNumber !== 'number') {
        return toolErrorResult('owner, repo and pull_number are required');
      }
      if (owner !== VIEWER_LOGIN) return toolErrorResult('Not Found');
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolErrorResult('Not Found');
      const pull = repo.pulls.find((p) => p.number === pullNumber);
      if (!pull) return toolErrorResult('Not Found');
      if (pull.state !== 'open') return toolErrorResult('Pull request is already merged or closed');
      if (!store.pullMergeable(repo, pull)) return toolErrorResult('Merge conflict');
      const files = store.squashTree(repo, pull);
      const baseTip = repo.refs.get(`refs/heads/${pull.base}`)!;
      const mergeOid = store.commitFiles(repo, files, `Merge pull request #${pull.number} from ${pull.head}`, baseTip, Math.floor(Date.now() / 1000));
      repo.refs.set(`refs/heads/${pull.base}`, mergeOid);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = nowIso();
      pull.mergeCommitSha = mergeOid;
      return toolOkResult({ merged: true, sha: mergeOid, message: 'Pull request successfully merged' });
    }
    default:
      return { __unknownTool: true } as Record<string, unknown>;
  }
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, rawBody: Buffer): Promise<boolean> {
  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  if (!isRecord(body) || typeof body.method !== 'string') {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return true;
  }
  const id = 'id' in body ? body.id : undefined;
  const method = body.method;
  const params = isRecord(body.params) ? (body.params as Record<string, unknown>) : {};

  // Notifications (no id) get a bare 202.
  if (id === undefined) {
    res.writeHead(202);
    res.end();
    return true;
  }

  if (method === 'server/discover') {
    rpcResult(res, id, {
      supportedVersions: [MODERN_VERSION, ...LEGACY_VERSIONS],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return true;
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : MODERN_VERSION;
    rpcResult(res, id, {
      protocolVersion: offered,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return true;
  }

  if (method === 'tools/list') {
    if (!isAuthenticated(req)) {
      jsonError(res, 401, 'Requires authentication');
      return true;
    }
    rpcResult(res, id, { tools: TOOLS });
    return true;
  }

  if (method === 'tools/call') {
    if (!isAuthenticated(req)) {
      jsonError(res, 401, 'Requires authentication');
      return true;
    }
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const result = callTool(name, args);
    if (result.__unknownTool) {
      rpcError(res, id, -32601, `Method not found: ${name}`);
      return true;
    }
    rpcResult(res, id, result);
    return true;
  }

  if (method === 'ping') {
    rpcResult(res, id, {});
    return true;
  }

  rpcError(res, id, -32601, `Method not found: ${method}`);
  return true;
}

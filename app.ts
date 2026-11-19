// The HTTP server: routing, auth, and the git smart-HTTP request parsing.
// Pure protocol work lives in gitproto.ts, REST in rest.ts, GraphQL in graphql.ts, MCP in mcp.ts.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { store, VIEWER_LOGIN } from './store.ts';
import {
  decodePktLines,
  uploadPackAdvertisement,
  receivePackAdvertisement,
  handleLsRefs,
  handleFetchV2,
  handleFetchV0,
  handleReceivePack,
  type FetchRequest,
} from './gitproto.ts';
import { handleRest, isAuthenticated } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { sendJson, jsonError, requestId } from './http-util.ts';

const MAX_BODY_BYTES = 256 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendBinary(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId(),
  });
  res.end(body);
}

function isV2(req: IncomingMessage): boolean {
  const header = req.headers['git-protocol'];
  return typeof header === 'string' && header.split(',').some((v) => v.trim().toLowerCase() === 'version=2');
}

/** Parse a v2 upload-pack request body into a command and argument lines. */
function parseV2Request(body: Buffer): { command: string; args: string[] } {
  const pkts = decodePktLines(body);
  const lines: string[] = [];
  let delimSeen = false;
  for (const pkt of pkts) {
    if (pkt.kind === 'delim') {
      delimSeen = true;
      continue;
    }
    if (pkt.kind === 'flush') break;
    lines.push(pkt.payload.toString('utf8').replace(/\n$/, ''));
  }
  if (!delimSeen && lines.length === 0) throw new Error('empty v2 request');
  const first = lines[0] ?? '';
  if (!first.startsWith('command=')) throw new Error('v2 request has no command');
  return { command: first.slice('command='.length), args: lines.slice(1) };
}

/** Parse a v0 upload-pack request body into a fetch request. */
function parseV0Fetch(body: Buffer): FetchRequest {
  const pkts = decodePktLines(body);
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, deepenSince: null };
  for (const pkt of pkts) {
    if (pkt.kind !== 'data') continue; // flushes separate the two sections; both are parsed the same way
    const line = pkt.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0]!;
      req.wants.push(oid);
    } else if (line.startsWith('have ')) {
      req.haves.push(line.slice(5).trim());
    } else if (line.startsWith('shallow ')) {
      req.shallow.push(line.slice(8).trim());
    } else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isFinite(n)) req.depth = n;
    } else if (line.startsWith('deepen-since ')) {
      const n = Number(line.slice(13).trim());
      if (Number.isFinite(n)) req.deepenSince = n;
    } else if (line === 'done') {
      // negotiation end
    }
    // deepen-not and capability words on the first want line are ignored
  }
  if (req.wants.length === 0) throw new Error('v0 fetch has no want');
  return req;
}

function parseV2Fetch(args: string[]): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, deepenSince: null };
  for (const line of args) {
    if (line.startsWith('want ')) req.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isFinite(n)) req.depth = n;
    } else if (line.startsWith('deepen-since ')) {
      const n = Number(line.slice(13).trim());
      if (Number.isFinite(n)) req.deepenSince = n;
    }
    // thin-pack, no-progress, ofs-delta, filter, agent, object-format, done: accepted, no effect
  }
  if (req.wants.length === 0) throw new Error('v2 fetch has no want');
  return req;
}

async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  action: 'info/refs' | 'git-upload-pack' | 'git-receive-pack',
  body: Buffer,
  query: URLSearchParams,
): Promise<void> {
  if (!isAuthenticated(req)) {
    jsonError(res, 401, 'Requires authentication');
    return;
  }
  if (owner !== VIEWER_LOGIN) {
    jsonError(res, 404, 'Not Found');
    return;
  }
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    jsonError(res, 404, 'Not Found');
    return;
  }
  try {
    if (action === 'info/refs') {
      const service = query.get('service');
      if (service === 'git-upload-pack') {
        sendBinary(res, 200, 'application/x-git-upload-pack-advertisement', uploadPackAdvertisement(repo, isV2(req)));
      } else if (service === 'git-receive-pack') {
        sendBinary(res, 200, 'application/x-git-receive-pack-advertisement', receivePackAdvertisement(repo));
      } else {
        jsonError(res, 400, 'service is required');
      }
      return;
    }
    if (action === 'git-upload-pack') {
      if (isV2(req)) {
        const { command, args } = parseV2Request(body);
        if (command === 'ls-refs') {
          sendBinary(res, 200, 'application/x-git-upload-pack-result', handleLsRefs(repo, args));
        } else if (command === 'fetch') {
          sendBinary(res, 200, 'application/x-git-upload-pack-result', handleFetchV2(repo, parseV2Fetch(args)));
        } else {
          jsonError(res, 400, `unknown command: ${command}`);
        }
      } else {
        sendBinary(res, 200, 'application/x-git-upload-pack-result', handleFetchV0(repo, parseV0Fetch(body)));
      }
      return;
    }
    // git-receive-pack
    const { report, status } = handleReceivePack(repo, body);
    sendBinary(res, status, 'application/x-git-receive-pack-result', report);
  } catch (err) {
    // A malformed git request must never crash the server or take it down.
    jsonError(res, 400, err instanceof Error ? err.message : 'malformed request');
  }
}

export function createApp(): Server {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const method = req.method ?? 'GET';
        const path = decodeURIComponent(url.pathname);
        const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

        // Health probe: no auth.
        if (path === '/healthz' && method === 'GET') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // GraphQL.
        if (path === '/api/graphql' && method === 'POST') {
          await handleGraphql(req, res, body);
          return;
        }

        // MCP.
        if (path === '/mcp' && method === 'POST') {
          await handleMcp(req, res, body);
          return;
        }

        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const segments = path === '/api/v3' ? [] : path.slice('/api/v3/'.length).split('/').filter((s) => s !== '');
          let parsedBody: unknown = undefined;
          if (body.length > 0) {
            try {
              parsedBody = JSON.parse(body.toString('utf8')) as unknown;
            } catch {
              jsonError(res, 400, 'Problems parsing JSON');
              return;
            }
          }
          const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
          handleRest(req, res, {
            method,
            segments,
            query: url.searchParams,
            baseUrl: origin,
            body: parsedBody,
            rawBody: body,
          });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/info/refs | git-upload-pack | git-receive-pack
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch) {
          const [, owner, repoName, action] = gitMatch;
          if ((action === 'info/refs' && method !== 'GET') || (action !== 'info/refs' && method !== 'POST')) {
            jsonError(res, 405, 'Method Not Allowed');
            return;
          }
          await handleGit(req, res, owner!, repoName!, action as 'info/refs' | 'git-upload-pack' | 'git-receive-pack', body, url.searchParams);
          return;
        }

        jsonError(res, 404, 'Not Found');
      } catch (err) {
        if (!res.headersSent) {
          try {
            jsonError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
          } catch {
            res.destroy();
          }
        } else {
          res.destroy();
        }
      }
    })();
  });
  return server;
}

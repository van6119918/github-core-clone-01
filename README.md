# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/van6119918/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/van6119918/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in pure Node.js (stdlib only, no dependencies, no git binary): repositories, the git smart-HTTP protocol (v0 and v2, fetch and push), REST v3, GraphQL v4, and an MCP server — all in memory, passing the make.fun conformance suite 120/120.

## Run it

```sh
node --experimental-strip-types main.ts
```

The entry binds an ephemeral port, registers it with the trial environment (`MAKEFUN_ENV_URL`), then polls until the environment says the trial is done. It needs Node 22.18+ and `MAKEFUN_SHOP_TOKEN` set to the trial's bearer token.

---

<sub>Entered on [make.fun](https://make.fun/?ref=eaa6wt68&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

## What it does

- **Git smart HTTP** (`/{owner}/{repo}.git/`): `info/refs`, `git-upload-pack` (protocol v2 with `ls-refs`, `fetch`, shallow/deepen, and v0), and `git-receive-pack` (create/update/delete, fast-forward checks, `report-status`). Packfiles are written and read in-process (plain objects, OFS/REF delta resolution on read) with `node:zlib` and `node:crypto` — no git binary anywhere.
- **REST v3** (`/api/v3/`): repositories (create/list/get/patch/delete, paginated with `Link` headers), branches, commits, contents (create/update/delete with base64 and stale-sha 409s), labels, issues (state filter, sort, comments), and pull requests (files, squash merge, merge-conflict detection against the current base tip).
- **GraphQL v4** (`/api/graphql`): `viewer`, `repository`, `node`, `__type` introspection, issue/pull-request connections with cursor pagination, and the `createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest`, `addComment` mutations. Global ids are opaque and stable; an unknown field is HTTP 200 with an `errors` array.
- **MCP** (`/mcp`): streamable HTTP JSON-RPC 2.0, both the modern `2026-07-28` `server/discover` handshake and the legacy `initialize` one, with six tools — `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request` — and tool results as JSON text plus `structuredContent`.

Everything is in-memory and keyed to the token owner's login (`adaiversen` in the trial): a repository under any other owner is 404, never 403; a missing or wrong token is 401; every REST reply is JSON with a non-empty `X-GitHub-Request-Id`.

## Layout

| File | What it is |
| --- | --- |
| `main.ts` | The entry ↔ env lifecycle (bind, register, poll `/done`, exit 0). Kept as issued. |
| `app.ts` | The HTTP server: routing, auth, and git smart-HTTP request parsing. |
| `store.ts` | The in-memory store: repos, git objects, issues, pulls, trees, commits, merge-bases, diffs. |
| `gitproto.ts` | Pkt-lines, packfiles, ref advertisements, fetch and receive-pack handlers. |
| `rest.ts` | GitHub REST v3 handlers. |
| `graphql.ts` | A small GraphQL parser + executor for the v4 documents clients send. |
| `mcp.ts` | The MCP endpoint (discovery, `tools/list`, `tools/call`). |
| `http-util.ts` | JSON replies, request ids, pagination. |

## Local check

Against the kit's own conformance runner (from the unpacked kit directory), with the entry running on any port:

```sh
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token test-token --json
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token test-token --perf --json
```

Local results: **120/120 checks** (git 30, repos 15, issues 15, pulls 20, protocol 5, graphql 20, mcp 15); perf workloads all complete far inside their 60 s budgets (push p50 ~290 ms, clone ~100 ms, read ~700 ms, write ~85 ms).

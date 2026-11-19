// main.ts — the entrypoint. It starts the forge, introduces it to the trial
// environment, and stays alive until the environment says the trial is over.
//
// The environment owns the suite; this process has only three jobs. First it
// listens on a port the kernel picks — never 8080, which is the env's own
// port. Then it tells the env which port it picked, with POST /register.
// Then it waits until the env reports the trial finished, with GET /done,
// and shuts down with exit 0.
//
// The forge itself lives in app.ts. This file is only the handshake with the
// harness, so it imports the app and nothing else: no package, no Node
// built-in, no model call.

import { createApp } from './app.ts';

// Where the env lives, from the environment. Trailing slashes are trimmed so
// the paths below join cleanly. With no origin there is nobody to talk to,
// so the program stops at once: run() throws and the handler below reports it.
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

// A single register or done request may take this long before it is dropped
// and tried again.
const REQUEST_BUDGET_MS = 30_000;
// Retries start this far apart and double after every failure, up to the cap.
const RETRY_FIRST_MS = 250;
const RETRY_CAP_MS = 2_000;

// Pause for `ms` milliseconds.
function pause(ms: number): Promise<void> {
  return new Promise((wake) => setTimeout(wake, ms));
}

// How long to wait before retry number `n` (counting from zero): the wait
// doubles each time, but never passes RETRY_CAP_MS, and the doubling stops
// after eight steps.
function backoffMs(n: number): number {
  const step = n > 8 ? 8 : n;
  const wait = RETRY_FIRST_MS * 2 ** step;
  return wait < RETRY_CAP_MS ? wait : RETRY_CAP_MS;
}

// One HTTP round trip, or null when it fails outright (network down, timeout,
// refused connection). The caller decides whether a null is worth retrying.
async function call(url: string, init?: RequestInit): Promise<Response | null> {
  const attempt = fetch(url, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
  });
  return attempt.catch(() => null);
}

// Announce the bound port to the env. It keeps trying until the env takes it
// (200) or reports that a first registration already won (409). A 400 or 405
// is a contract error and ends the program; anything else is retried, since
// the env may still be starting up.
async function announce(port: number): Promise<void> {
  const payload = JSON.stringify({ port });
  const headers = { 'content-type': 'application/json' };
  let failures = 0;
  for (;;) {
    const res = await call(`${envOrigin}/register`, { method: 'POST', body: payload, headers });
    if (res !== null) {
      const taken = res.status === 200 || res.status === 409;
      if (taken) return;
      const contractError = res.status === 400 || res.status === 405;
      if (contractError) {
        const detail = await res.text().catch(() => '');
        throw new Error(`register answered HTTP ${res.status}: ${detail}`);
      }
    }
    await pause(backoffMs(failures));
    failures += 1;
  }
}

// Read one /done answer: true only when the body parses and says done.
async function isDone(res: Response | null): Promise<boolean> {
  if (res === null || !res.ok) return false;
  const payload = (await res.json().catch(() => null)) as { done?: unknown } | null;
  return payload !== null && payload.done === true;
}

// Ask GET /done until the env answers {"done": true}; never return before that.
async function awaitDone(): Promise<void> {
  let failures = 0;
  for (;;) {
    const res = await call(`${envOrigin}/done`);
    if (await isDone(res)) return;
    await pause(backoffMs(failures));
    failures += 1;
  }
}

// Start the app on a kernel-chosen port and report the bound port number.
async function listenEphemeral(server: ReturnType<typeof createApp>): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, () => {
      const bound = server.address();
      if (bound === null || typeof bound === 'string') {
        reject(new Error('the server did not bind an ephemeral TCP port'));
        return;
      }
      resolve(bound.port);
    });
  });
}

// Bind a port, register it, then wait for the env: the whole life of the process.
async function run(): Promise<void> {
  if (envOrigin.length === 0) {
    throw new Error('MAKEFUN_ENV_URL is not set: there is no env to register with');
  }
  const app = createApp();
  const port = await listenEphemeral(app);
  process.stdout.write(`[entry] listening on port ${port}\n`);
  await announce(port);
  process.stdout.write('[entry] registered; waiting until the env says done\n');
  await awaitDone();
  app.close();
  process.stdout.write('[entry] trial done, shutting down\n');
}

run().then(
  () => process.exit(0),
  (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[entry] ${message}\n`);
    process.exit(1);
  },
);

// main.ts — entrypoint: bind an ephemeral port, register with the
// trial environment, serve until the environment reports done, then exit.
//
// With MAKEFUN_ENV_URL set (the graded trial) this is the full lifecycle.
// Without it (local development) the server simply listens on $PORT
// (default 3000) and serves until stopped.

import { createAppServer } from './app.ts';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function register(envUrl, port) {
  // Returns 'ok' (registered), 'taken' (another entry registered first),
  // or throws on fatal/unrecoverable failure.
  const deadline = Date.now() + 60000;
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      const res = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 200) return 'ok';
      if (res.status === 409) return 'taken';
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register rejected with ${res.status}`);
      }
      // Other statuses: retry with backoff.
    } catch (e) {
      if (e && /register rejected/.test(e.message)) throw e;
      // Network errors: retry.
    }
    if (Date.now() >= deadline) throw new Error('register timed out');
    await sleep(Math.min(500 * attempt, 3000));
  }
}

async function waitForDone(envUrl) {
  while (true) {
    try {
      const res = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(5000) });
      if (res.status === 200) {
        const body = await res.json();
        if (body && body.done === true) return;
      }
    } catch {
      // Transient fetch failure: keep polling.
    }
    await sleep(1000);
  }
}

async function main() {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  const server = createAppServer();

  if (!envUrl) {
    // Local development mode.
    const port = Number(process.env.PORT ?? 3000);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, () => resolve());
    });
    console.log(`github-core-clone listening on http://127.0.0.1:${port} (standalone mode)`);
    return;
  }

  // Trial mode: ephemeral port, register, serve until done.
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve(server.address().port));
  });
  const outcome = await register(envUrl, port);
  if (outcome === 'taken') {
    console.log('another entry registered first; waiting for trial to end');
  }
  await waitForDone(envUrl);
  await new Promise((resolve) => server.close(() => resolve()));
  process.exit(0);
}

main().catch((e) => {
  console.error('fatal:', e && e.message ? e.message : e);
  process.exit(1);
});

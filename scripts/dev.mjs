#!/usr/bin/env node
/**
 * Starts the development environment: the content server, then `ng serve` in
 * front of it.
 *
 * One command has to start both, because the application is useless without
 * its content and the content now comes from a directory that may live
 * anywhere on disk (`docs/adr/ADR-0022-authoring-content-workspace.md`). The
 * Angular builder accepts no middleware of its own, so the seam is a proxy:
 * `/content` and `/api/content` are forwarded to the content server, and
 * everything else is the Angular application.
 *
 * The content server takes a port from the operating system and the proxy
 * configuration is written with that port at startup. A fixed port would make
 * two dev servers — a developer's and the smoke harness's — fight over it, and
 * the loser would silently serve the wrong game's content.
 *
 * Any extra arguments go to `ng serve` untouched, so `npm start -- --port 4399`
 * keeps working.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { REPO_ROOT, contentDir, describeContentDir } from './content-dir.mjs';
import { startContentServer } from './content-server.mjs';

const WEB_ROOT = resolve(REPO_ROOT, 'apps', 'web');
const PROXY_CONFIG = resolve(WEB_ROOT, '.angular', 'insulaire-content-proxy.json');
/** Where `scripts/sync-content.mjs` mirrors content for a *build*. */
const BUILD_MIRROR = resolve(WEB_ROOT, 'public', 'content');

const dir = contentDir();

// A mirror left behind by an earlier `npm run build` sits at the same URL as
// the proxy and wins, which would serve yesterday's content for the rest of the
// session. It is generated output, so removing it costs nothing.
if (existsSync(BUILD_MIRROR)) {
  await rm(BUILD_MIRROR, { recursive: true, force: true });
  console.log('[dev] removed the build content mirror; the dev server proxies the real directory');
}

const server = await startContentServer({ root: dir.path });
const target = `http://127.0.0.1:${server.port}`;

await mkdir(dirname(PROXY_CONFIG), { recursive: true });
await writeFile(
  PROXY_CONFIG,
  `${JSON.stringify(
    {
      '/content': { target, secure: false, changeOrigin: false },
      '/api/content': { target, secure: false, changeOrigin: false },
    },
    null,
    2,
  )}\n`,
);

console.log(`[dev] ${describeContentDir(dir)}`);
console.log(`[dev] content server on ${target}`);

const ng = resolve(REPO_ROOT, 'node_modules', '.bin', 'ng');
const child = spawn(
  process.execPath,
  [ng, 'serve', '--proxy-config', PROXY_CONFIG, ...process.argv.slice(2)],
  { cwd: WEB_ROOT, stdio: 'inherit' },
);

let stopping = false;
async function stop(signal) {
  if (stopping) {
    return;
  }
  stopping = true;
  child.kill(signal ?? 'SIGTERM');
  await server.close();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void stop(signal);
  });
}

child.on('exit', (code, signal) => {
  void stop().then(() => {
    process.exit(signal ? 1 : (code ?? 0));
  });
});

#!/usr/bin/env node
/**
 * The authoring content server: serves one content directory over HTTP, and
 * lets the editor write into it.
 *
 * # What this is, and what it is not
 *
 * It is a **development tool**. It exists because a game is authored against
 * real files — images, music, worlds — that live outside this repository, and
 * because a browser cannot write to a directory on its own. It runs next to the
 * Angular dev server, which proxies `/content` and `/api/content` to it
 * (`docs/adr/ADR-0022-authoring-content-workspace.md`).
 *
 * It is **not** part of the game. The runtime still loads content over plain
 * HTTP from static files, and the delivered executable embeds them: no build of
 * the game ever talks to this server, and ADR-0012's "no backend" is unchanged.
 * That is why it binds to the loopback interface and refuses everything that is
 * not a content file inside its one directory.
 *
 * # Endpoints
 *
 * ```text
 *   GET    /api/content/health        which directory is being served
 *   GET    /api/content/tree          every content file, with size and mtime
 *   GET    /content/<path>            read a file
 *   PUT    /api/content/<path>        write a file, creating directories
 *   DELETE /api/content/<path>        remove a file
 * ```
 */
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

import { contentDir, describeContentDir } from './content-dir.mjs';
import { MAX_UPLOAD_BYTES, contentTypeOf, safeContentPath } from './content-paths.mjs';

const READ_PREFIX = '/content/';
const API_PREFIX = '/api/content/';

/**
 * Creates the server. Call `listen` on the result, or use {@link startContentServer}.
 *
 * @param {{ root: string, readOnly?: boolean }} options
 */
export function createContentServer({ root, readOnly = false }) {
  return createServer((request, response) => {
    handle(request, response, root, readOnly).catch((cause) => {
      sendJson(response, 500, { error: cause instanceof Error ? cause.message : String(cause) });
    });
  });
}

async function handle(request, response, root, readOnly) {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (path === '/api/content/health') {
    return sendJson(response, 200, { root, readOnly });
  }

  if (path === '/api/content/tree') {
    return sendJson(response, 200, { root, readOnly, files: await tree(root) });
  }

  if (path.startsWith(READ_PREFIX) && request.method === 'GET') {
    return readEntry(response, root, path.slice(READ_PREFIX.length));
  }

  if (path.startsWith(API_PREFIX)) {
    const target = path.slice(API_PREFIX.length);
    if (request.method === 'GET') {
      return readEntry(response, root, target);
    }
    if (request.method === 'PUT' || request.method === 'DELETE') {
      if (readOnly) {
        return sendJson(response, 403, { error: 'this content server is read-only' });
      }
      return request.method === 'PUT'
        ? writeEntry(request, response, root, target)
        : deleteEntry(response, root, target);
    }
    return sendJson(response, 405, { error: `${request.method} is not supported here` });
  }

  return sendJson(response, 404, { error: `no content route for ${path}` });
}

// ------------------------------------------------------------------ handlers

/** Every allowed content file under `root`, as paths relative to it. */
async function tree(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const absolute = join(entry.parentPath ?? entry.path, entry.name);
    const path = relative(root, absolute).split(sep).join('/');
    if (contentTypeOf(path) === null) {
      continue;
    }
    const stats = await stat(absolute);
    files.push({ path, size: stats.size, modifiedAt: stats.mtime.toISOString() });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

async function readEntry(response, root, target) {
  const resolved = safeContentPath(root, target);
  if (!resolved.ok) {
    return sendJson(response, 400, { error: resolved.reason });
  }
  try {
    const body = await readFile(resolved.path);
    response.writeHead(200, {
      'content-type': contentTypeOf(resolved.relative),
      'content-length': body.byteLength,
      // Authoring means the file on disk changes under a running page; a cached
      // response would show the author yesterday's asset.
      'cache-control': 'no-store',
    });
    return response.end(body);
  } catch (cause) {
    if (cause.code === 'ENOENT' || cause.code === 'EISDIR') {
      return sendJson(response, 404, { error: `no content file at ${resolved.relative}` });
    }
    throw cause;
  }
}

async function writeEntry(request, response, root, target) {
  const resolved = safeContentPath(root, target);
  if (!resolved.ok) {
    return sendJson(response, 400, { error: resolved.reason });
  }

  const body = await readBody(request);
  if (body === null) {
    return sendJson(response, 413, {
      error: `the body exceeds the ${MAX_UPLOAD_BYTES} byte limit`,
    });
  }

  await mkdir(dirname(resolved.path), { recursive: true });
  await writeFile(resolved.path, body);
  return sendJson(response, 200, { path: resolved.relative, size: body.byteLength });
}

async function deleteEntry(response, root, target) {
  const resolved = safeContentPath(root, target);
  if (!resolved.ok) {
    return sendJson(response, 400, { error: resolved.reason });
  }
  await rm(resolved.path, { force: true });
  return sendJson(response, 200, { path: resolved.relative, deleted: true });
}

// ------------------------------------------------------------------ plumbing

/** The whole request body, or `null` when it exceeds the limit. */
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        request.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

/**
 * Starts the server on the loopback interface.
 *
 * Port `0` asks the operating system for a free one, which is what the dev
 * launcher uses: two dev servers (a developer's and the smoke harness's) must
 * be able to run side by side without fighting over a fixed port.
 *
 * @returns {Promise<{ port: number, root: string, close: () => Promise<void> }>}
 */
export function startContentServer({ root, port = 0, readOnly = false }) {
  const server = createContentServer({ root, readOnly });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        root,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

// Run directly (`node scripts/content-server.mjs [port]`) for a standalone
// server; `scripts/dev.mjs` starts it in-process instead.
if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = contentDir();
  const port = Number(process.argv[2] ?? process.env.INSULAIRE_CONTENT_PORT ?? 4210);
  const server = await startContentServer({ root: dir.path, port });
  console.log(`[content-server] http://127.0.0.1:${server.port} — ${describeContentDir(dir)}`);
}

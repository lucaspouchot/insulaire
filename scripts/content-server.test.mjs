/**
 * The content server's tile-art bundle route, driven over real HTTP.
 *
 * The path rules have their own suite (`content-paths.test.mjs`); what is left
 * to prove here is the one route that answers with something no file on disk
 * holds, and that it stops answering with yesterday's art the moment the files
 * under it move (`docs/adr/ADR-0027-a-map-is-drawn-from-shared-pictures.md`).
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { startContentServer } from './content-server.mjs';
import { TILE_ART_BUNDLE, TILE_ART_DIR } from './sprite-bundle.mjs';

const cleanups = [];

after(async () => {
  await Promise.all(cleanups.map((cleanup) => cleanup()));
});

/** A server over a fresh content directory holding `files`. */
async function serve(files) {
  const root = await mkdtemp(join(tmpdir(), 'insulaire-server-'));
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), body);
  }
  const server = await startContentServer({ root });
  cleanups.push(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, base: `http://127.0.0.1:${server.port}` };
}

/** The bundle's payload, as text, so a test can assert on what it carries. */
function payloadOf(bundle) {
  const headerBytes = bundle.readUInt32LE(8);
  return bundle.subarray(12 + headerBytes).toString('utf8');
}

test('the bundle route answers with every sprite under the tile directory', async () => {
  const { base } = await serve({
    [`${TILE_ART_DIR}/grass/flat/grass_a.png`]: 'PNG-A',
    [`${TILE_ART_DIR}/rock/flat/rock_a.png`]: 'PNG-R',
    'worlds/demo.json': '{}',
  });

  const response = await fetch(`${base}/content/${TILE_ART_BUNDLE}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');

  const bundle = Buffer.from(await response.arrayBuffer());
  assert.equal(bundle.subarray(0, 4).toString('ascii'), 'ISLB');
  // The world is content, but it is not a sprite: it must not be in here.
  assert.equal(payloadOf(bundle), 'PNG-APNG-R');
});

test('a repainted sprite is in the next bundle', async () => {
  const { root, base } = await serve({ [`${TILE_ART_DIR}/grass/flat/grass_a.png`]: 'PNG-A' });
  const url = `${base}/content/${TILE_ART_BUNDLE}`;

  const before = Buffer.from(await (await fetch(url)).arrayBuffer());
  assert.equal(payloadOf(before), 'PNG-A');

  // What the asset editor does, through this very server (ADR-0028).
  const written = await fetch(`${base}/api/content/${TILE_ART_DIR}/grass/flat/grass_a.png`, {
    method: 'PUT',
    body: 'PNG-A-REPAINTED',
  });
  assert.equal(written.status, 200);

  const after_ = Buffer.from(await (await fetch(url)).arrayBuffer());
  assert.equal(payloadOf(after_), 'PNG-A-REPAINTED');
});

test('an unchanged directory answers with the same bytes', async () => {
  const { base } = await serve({ [`${TILE_ART_DIR}/grass/flat/grass_a.png`]: 'PNG-A' });
  const url = `${base}/content/${TILE_ART_BUNDLE}`;

  const first = Buffer.from(await (await fetch(url)).arrayBuffer());
  const second = Buffer.from(await (await fetch(url)).arrayBuffer());

  assert.deepEqual(first, second);
});

test('a project with no tile art still answers with a readable bundle', async () => {
  const { base } = await serve({ 'worlds/demo.json': '{}' });

  const response = await fetch(`${base}/content/${TILE_ART_BUNDLE}`);

  assert.equal(response.status, 200);
  const bundle = Buffer.from(await response.arrayBuffer());
  assert.equal(bundle.subarray(0, 4).toString('ascii'), 'ISLB');
  assert.equal(payloadOf(bundle), '');
});

test('the bundle cannot be written through the API', async () => {
  const { base } = await serve({ [`${TILE_ART_DIR}/grass/flat/grass_a.png`]: 'PNG-A' });

  const response = await fetch(`${base}/api/content/${TILE_ART_BUNDLE}`, {
    method: 'PUT',
    body: 'not a bundle',
  });

  // It is generated output, and `.bundle` is not an allowed content extension:
  // nothing may upload one and have the server serve it back.
  assert.equal(response.status, 400);
});

test('the bundle is not listed as an authored content file', async () => {
  const { base } = await serve({ [`${TILE_ART_DIR}/grass/flat/grass_a.png`]: 'PNG-A' });

  const tree = await (await fetch(`${base}/api/content/tree`)).json();

  assert.deepEqual(
    tree.files.map((file) => file.path),
    [`${TILE_ART_DIR}/grass/flat/grass_a.png`],
  );
});

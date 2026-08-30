/**
 * What the bundle writer must guarantee, tested against a real directory.
 *
 * Run by `npm run test:scripts`. The *reading* half lives in
 * `apps/web/src/content/sprite-bundle.spec.ts`, which imports this module's
 * packer so the two halves of the format cannot drift apart
 * (`docs/adr/ADR-0027-a-map-is-drawn-from-shared-pictures.md`).
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  FORMAT_VERSION,
  MAGIC,
  TILE_ART_DIR,
  collectSprites,
  packSpriteBundle,
  spriteSignature,
} from './sprite-bundle.mjs';

const roots = [];

/** A content directory holding `files`, removed when the run ends. */
async function contentRoot(files) {
  const root = await mkdtemp(join(tmpdir(), 'insulaire-bundle-'));
  roots.push(root);
  for (const [path, body] of Object.entries(files)) {
    const absolute = join(root, path);
    await mkdir(join(absolute, '..'), { recursive: true });
    await writeFile(absolute, body);
  }
  return root;
}

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

test('the bundle starts with the magic and the version', async () => {
  const root = await contentRoot({ [`${TILE_ART_DIR}/grass/flat/grass_a.png`]: 'PNG-A' });
  const bundle = packSpriteBundle(await collectSprites(root, TILE_ART_DIR));

  assert.equal(bundle.subarray(0, 4).toString('ascii'), MAGIC);
  assert.equal(bundle.readUInt32LE(4), FORMAT_VERSION);
});

test('every file under the directory is carried, with its content type', async () => {
  const root = await contentRoot({
    [`${TILE_ART_DIR}/grass/flat/grass_a.png`]: 'PNG-A',
    [`${TILE_ART_DIR}/rock/elevation/level_1/rock_b.png`]: 'PNG-B',
  });

  const sprites = await collectSprites(root, TILE_ART_DIR);

  assert.deepEqual(
    sprites.map((sprite) => sprite.path),
    [
      `${TILE_ART_DIR}/grass/flat/grass_a.png`,
      `${TILE_ART_DIR}/rock/elevation/level_1/rock_b.png`,
    ],
  );
  assert.equal(sprites[0].type, 'image/png');
  assert.equal(sprites[0].bytes.toString('utf8'), 'PNG-A');
});

test('a file the content rules do not allow stays out of the payload', async () => {
  const root = await contentRoot({
    [`${TILE_ART_DIR}/grass/flat/grass_a.png`]: 'PNG-A',
    [`${TILE_ART_DIR}/.DS_Store`]: 'junk',
    [`${TILE_ART_DIR}/notes.rtf`]: 'not a sprite',
  });

  const sprites = await collectSprites(root, TILE_ART_DIR);

  assert.deepEqual(
    sprites.map((sprite) => sprite.path),
    [`${TILE_ART_DIR}/grass/flat/grass_a.png`],
  );
});

test('the same directory packs to the same bytes twice', async () => {
  // A generated file that differs run to run makes every diff a lie about what
  // changed, and would defeat the signature the server caches on.
  const root = await contentRoot({
    [`${TILE_ART_DIR}/b/b.png`]: 'B',
    [`${TILE_ART_DIR}/a/a.png`]: 'A',
  });

  const first = packSpriteBundle(await collectSprites(root, TILE_ART_DIR));
  const second = packSpriteBundle(await collectSprites(root, TILE_ART_DIR));

  assert.deepEqual(first, second);
});

test('a project with no tile art bundles nothing rather than failing', async () => {
  const root = await contentRoot({ 'worlds/demo.json': '{}' });

  assert.deepEqual(await collectSprites(root, TILE_ART_DIR), []);
  assert.equal(await spriteSignature(root, TILE_ART_DIR), '');
});

test('the signature moves when a file is written, and only then', async () => {
  const root = await contentRoot({ [`${TILE_ART_DIR}/grass/flat/grass_a.png`]: 'PNG-A' });
  const before = await spriteSignature(root, TILE_ART_DIR);

  assert.equal(await spriteSignature(root, TILE_ART_DIR), before);

  // What the asset editor does: writes the same path with new pixels
  // (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`).
  const painted = join(root, TILE_ART_DIR, 'grass/flat/grass_a.png');
  await writeFile(painted, 'PNG-A-REPAINTED');
  assert.notEqual(await spriteSignature(root, TILE_ART_DIR), before);
});

test('the signature moves when a file is touched without changing size', async () => {
  // A `git checkout` puts back the same bytes with a new mtime; a seeder run
  // rewrites every file. Neither goes through the server, so size alone is not
  // enough to notice them.
  const root = await contentRoot({ [`${TILE_ART_DIR}/grass/flat/grass_a.png`]: 'PNG-A' });
  const before = await spriteSignature(root, TILE_ART_DIR);

  const touched = join(root, TILE_ART_DIR, 'grass/flat/grass_a.png');
  const later = new Date(Date.now() + 10_000);
  await utimes(touched, later, later);

  assert.notEqual(await spriteSignature(root, TILE_ART_DIR), before);
});

test('the signature moves when a file is added', async () => {
  const root = await contentRoot({ [`${TILE_ART_DIR}/grass/flat/grass_a.png`]: 'PNG-A' });
  const before = await spriteSignature(root, TILE_ART_DIR);

  await writeFile(join(root, TILE_ART_DIR, 'grass/flat/grass_b.png'), 'PNG-B');

  assert.notEqual(await spriteSignature(root, TILE_ART_DIR), before);
});

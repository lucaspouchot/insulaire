#!/usr/bin/env node
/**
 * Packs many small sprite files into **one** file the browser fetches once.
 *
 * # Why this exists
 *
 * A map's art is a hundred and eighty-four PNGs of about 1.4 kB each. Two
 * hundred and fifty kilobytes in total — nothing — but a hundred and
 * eighty-four round trips, and that is what the map waits on
 * (`docs/adr/ADR-0040-tile-art-travels-as-one-bundle.md`).
 *
 * Measured on the dev server, HTTP/1.1, `/editor/map`: the server answers each
 * image in **4 ms** and the browser spends a **median of 3.4 s** with the
 * request queued behind the six connections it is allowed. The cost is the
 * count, not the bytes and not the server. So the fix is to stop asking a
 * hundred and eighty-four times.
 *
 * # What this is not
 *
 * It is **not** a texture atlas. The sprites are not laid out on a grid, they
 * are not composed, and nothing downstream draws from a source rectangle: the
 * browser slices the bundle back into one image per asset at load and the
 * renderer keeps blitting exactly what it blitted before. This is a transport
 * format, and the pixels are byte-identical either side of it.
 *
 * # Layout
 *
 * ```text
 *   0   magic        4 bytes   "ISLB"
 *   4   version      u32 LE    FORMAT_VERSION
 *   8   headerBytes  u32 LE    length of the JSON header
 *   12  header       JSON, utf-8, headerBytes long
 *   ..  payload      every file, concatenated, in header order
 * ```
 *
 * The header is `{ "entries": [ { path, type, offset, length } ] }`, where
 * `offset` counts from the first byte of the payload. JSON rather than a packed
 * table because the header is read once, it is a few kilobytes against a few
 * hundred, and a format somebody can read in a hex dump is a format somebody
 * can debug.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { contentTypeOf } from './content-paths.mjs';

/** First four bytes of every bundle. */
export const MAGIC = 'ISLB';
/** Bumped when the layout changes; the reader refuses anything else. */
export const FORMAT_VERSION = 1;
/** Where the tile-art bundle lives, relative to the content root. */
export const TILE_ART_BUNDLE = 'tile-art.bundle';
/** The directory the tile-art bundle covers, relative to the content root. */
export const TILE_ART_DIR = 'assets/tiles';

/**
 * Packs `files` into one buffer.
 *
 * @param {{ path: string, type: string, bytes: Buffer }[]} files in the order they should appear
 * @returns {Buffer}
 */
export function packSpriteBundle(files) {
  const entries = [];
  let offset = 0;
  for (const file of files) {
    entries.push({ path: file.path, type: file.type, offset, length: file.bytes.byteLength });
    offset += file.bytes.byteLength;
  }

  const header = Buffer.from(JSON.stringify({ entries }), 'utf8');
  const prologue = Buffer.alloc(12);
  prologue.write(MAGIC, 0, 'ascii');
  prologue.writeUInt32LE(FORMAT_VERSION, 4);
  prologue.writeUInt32LE(header.byteLength, 8);

  return Buffer.concat([prologue, header, ...files.map((file) => file.bytes)]);
}

/**
 * Every sprite file under `directory`, as bundle input, sorted by path.
 *
 * Sorted because a bundle built twice from the same directory has to be the
 * same bytes: a diff in a generated file should mean the art changed.
 *
 * Files whose extension the content rules do not allow are skipped — the same
 * rule the server applies to every other read, applied here so a stray
 * `.DS_Store` cannot end up in the payload.
 *
 * @param {string} root absolute path of the content directory
 * @param {string} directory relative to `root`, e.g. `assets/tiles`
 * @returns {Promise<{ path: string, type: string, bytes: Buffer }[]>}
 */
export async function collectSprites(root, directory) {
  const paths = await spritePaths(root, directory);
  return Promise.all(
    paths.map(async (path) => ({
      path,
      type: contentTypeOf(path),
      bytes: await readFile(join(root, path)),
    })),
  );
}

/**
 * A signature of what `directory` holds right now: path, size and mtime.
 *
 * This is how a cached bundle knows it is stale. The content directory is
 * authored *while the server runs* — the asset editor writes through it, and a
 * `git checkout` or the seeder script can change it behind the server's back
 * (`docs/adr/ADR-0022-authoring-content-workspace.md`) — so a bundle held in
 * memory is only valid as long as this string is.
 *
 * Cheap enough to run on every request: a couple of hundred `stat` calls, a few
 * milliseconds, once per page load rather than once per image.
 *
 * @returns {Promise<string>}
 */
export async function spriteSignature(root, directory) {
  const paths = await spritePaths(root, directory);
  const stamps = await Promise.all(
    paths.map(async (path) => {
      const stats = await stat(join(root, path));
      return `${path}:${stats.size}:${stats.mtimeMs}`;
    }),
  );
  return stamps.join('\n');
}

/** Allowed content files under `root/directory`, as paths relative to `root`, sorted. */
async function spritePaths(root, directory) {
  const base = join(root, directory);
  let found;
  try {
    found = await readdir(base, { recursive: true, withFileTypes: true });
  } catch (cause) {
    if (cause.code === 'ENOENT') {
      // A project with no tile art bundles nothing, and that is not an error:
      // its tiles draw their `fallbackColor` exactly as they always have.
      return [];
    }
    throw cause;
  }

  return found
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const absolute = join(entry.parentPath ?? entry.path, entry.name);
      return relative(root, absolute).split(sep).join('/');
    })
    .filter((path) => contentTypeOf(path) !== null)
    .sort();
}

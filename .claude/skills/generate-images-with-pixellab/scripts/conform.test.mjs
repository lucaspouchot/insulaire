#!/usr/bin/env node
/**
 * Proves `conform.mjs` still puts an image on the geometry the tile set
 * declares — the same assertions `scripts/tile-art.test.mjs` makes of the
 * shipped art, made of a conformed one instead.
 *
 * The source is drawn here rather than fetched: a noisy square with a
 * transparent corner, which is the two things a generated image does wrong —
 * the wrong size, and a hole where the background was removed.
 *
 * ```bash
 * node --test .claude/skills/generate-images-with-pixellab/scripts/conform.test.mjs
 * ```
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { deflateSync, inflateSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFORM = join(HERE, 'conform.mjs');
const REPO = resolve(HERE, '../../../..');

/** The fixture's grid, which is what this test pins the tool against. */
const FIXTURE = join(REPO, 'content');
const TILE_SET = JSON.parse(readFileSync(join(FIXTURE, 'tilesets/mvp_terrain.json'), 'utf8'));
const { width, flatHeight, surfaceHeight, elevationHeight } = TILE_SET.art;
const shoulder = Math.floor(surfaceHeight / 4);
const band = elevationHeight - shoulder;

const CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'ascii');
  let c = 0xffffffff;
  for (const byte of Buffer.concat([head.subarray(4), body])) {
    c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE((c ^ 0xffffffff) >>> 0, 0);
  return Buffer.concat([head, body, tail]);
}

/** A 128x128 mottled square with a transparent corner, as a PNG. */
function source(path) {
  const size = 128;
  const data = new Uint8Array(size * size * 4);
  let seed = 12345;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const at = (y * size + x) * 4;
      const noise = Math.floor(random() * 40);
      data[at] = 60 + noise;
      data[at + 1] = 110 + noise;
      data[at + 2] = 50 + noise;
      data[at + 3] = x < 12 && y < 12 ? 0 : 255;
    }
  }
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    Buffer.from(data.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
  return path;
}

/** A conformed PNG as `{ width, height, alpha }`. */
function decodeAlpha(path) {
  const file = readFileSync(path);
  let at = 8;
  let imageWidth = 0;
  let imageHeight = 0;
  const parts = [];
  while (at < file.length) {
    const length = file.readUInt32BE(at);
    const type = file.toString('ascii', at + 4, at + 8);
    const body = file.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      imageWidth = body.readUInt32BE(0);
      imageHeight = body.readUInt32BE(4);
      assert.equal(body[8], 8, `${path}: expected 8 bits per channel`);
      assert.equal(body[9], 6, `${path}: expected RGBA`);
    }
    if (type === 'IDAT') parts.push(body);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const stride = imageWidth * 4;
  const alpha = new Uint8Array(imageWidth * imageHeight);
  let read = 0;
  for (let y = 0; y < imageHeight; y += 1) {
    assert.equal(raw[read], 0, `${path}: conform.mjs writes filter 0`);
    read += 1;
    for (let x = 0; x < imageWidth; x += 1) alpha[y * imageWidth + x] = raw[read + x * 4 + 3];
    read += stride;
  }
  return { width: imageWidth, height: imageHeight, alpha };
}

/** The first row and the height of the one opaque run in a column. */
function opaqueRun(image, x) {
  let first = -1;
  let last = -1;
  for (let y = 0; y < image.height; y += 1) {
    if (image.alpha[y * image.width + x] === 0) continue;
    if (first < 0) first = y;
    last = y;
  }
  if (first < 0) return null;
  for (let y = first; y <= last; y += 1) {
    assert.notEqual(image.alpha[y * image.width + x], 0, `column ${x} has a hole at row ${y}`);
  }
  return { first, height: last - first + 1 };
}

/** Rows of opaque pixels, one count per row. */
function rowWidths(image) {
  const rows = [];
  for (let y = 0; y < image.height; y += 1) {
    let count = 0;
    for (let x = 0; x < image.width; x += 1) {
      if (image.alpha[y * image.width + x] !== 0) count += 1;
    }
    rows.push(count);
  }
  return rows;
}

const work = mkdtempSync(join(tmpdir(), 'conform-'));
const input = source(join(work, 'source.png'));

function conform(shape, options = []) {
  const output = join(work, `${shape}.png`);
  execFileSync(
    process.execPath,
    [CONFORM, shape, input, output, '--tile-set', 'tilesets/mvp_terrain.json', ...options],
    { env: { ...process.env, INSULAIRE_CONTENT_DIR: FIXTURE }, stdio: 'pipe' },
  );
  return decodeAlpha(output);
}

test('a conformed flat is the untilted hexagon, whole and opaque', () => {
  const image = conform('flat');
  assert.deepEqual([image.width, image.height], [width, flatHeight]);

  const rows = rowWidths(image);
  const quarter = Math.round(flatHeight / 4);
  assert.equal(rows[quarter], width, `row ${quarter} is not the hexagon's full width`);
  assert.equal(rows[flatHeight - 1 - quarter], width);
  assert.ok(rows[0] <= width / 8, `the north vertex is ${rows[0]} pixels wide`);
  assert.ok(rows[flatHeight - 1] <= width / 8);
  // The transparent corner of the source must not survive as a hole.
  for (let x = 0; x < width; x += 1) assert.ok(opaqueRun(image, x) !== null, `column ${x} is empty`);
});

test('a conformed surface is the tilted hexagon', () => {
  const image = conform('surface');
  assert.deepEqual([image.width, image.height], [width, surfaceHeight]);
  const rows = rowWidths(image);
  assert.equal(rows[shoulder], width, 'the upper shoulder row is not the full width');
  assert.equal(rows[surfaceHeight - 1 - shoulder], width);
});

test('a conformed elevation image is a band that follows the V', () => {
  const image = conform('elevation');
  assert.deepEqual([image.width, image.height], [width, elevationHeight]);

  const tops = [];
  for (let x = 0; x < image.width; x += 1) {
    const run = opaqueRun(image, x);
    assert.ok(run !== null, `column ${x} draws nothing`);
    assert.equal(run.height, band, `column ${x} is ${run.height} rows, not a ${band}px band`);
    tops.push(run.first);
  }

  const middle = image.width / 2;
  assert.equal(tops[middle - 1], shoulder, `the V is not ${shoulder} deep`);
  assert.equal(tops[middle], shoulder);
  assert.ok(tops[0] <= 1, 'the band does not start at the west shoulder');
  assert.ok(tops[image.width - 1] <= 1, 'the band does not start at the east shoulder');
  for (let x = 1; x < image.width; x += 1) {
    const step = tops[x] - tops[x - 1];
    assert.ok(
      Math.abs(step) <= 1 && (x <= middle ? step >= 0 : step <= 0),
      `the band's top edge is not the hexagon's, at column ${x}`,
    );
  }
});

test('a conformed sprite is trimmed to its own box', () => {
  const image = conform('sprite', ['--size', '24x48']);
  assert.deepEqual([image.width, image.height], [24, 48]);
});

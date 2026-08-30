/**
 * The shipped tile art draws the shape the renderer extrudes.
 *
 * `docs/content-format.md` says an elevation image holds the two side faces as
 * a band **filling the canvas under the `V`, its lower edge following the same
 * `V` as its upper one** — the outline `faceGuides` marks in the asset editor,
 * and the outline of the `fallbackColor` wall the renderer fills behind the art
 * (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`). That
 * band is `elevationHeight - shoulderDepth` thick, which is *not* the same
 * question as how far a level lifts a cell: the shipped set lifts half a band
 * per level, and the renderer hides the other half under the layer above.
 *
 * Nothing enforced that, and it is invisible in the common case: a cliff whose
 * foot has ground in front of it has that ground's top face painted over
 * whatever juts out. It shows at the edge of the map, and beside a neighbour
 * standing higher than the cliff's foot — a flat cut where the hexagon's
 * silhouette should be. So the claim gets a test.
 *
 * Run by `npm run test:scripts`.
 */

import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT = join(REPO, 'content');

/**
 * A PNG as `{ width, height, alpha }`.
 *
 * Only what this file needs: 8-bit RGBA, non-interlaced, every filter type —
 * the generator writes filter 0 throughout, but an image repainted in the asset
 * editor comes back from a canvas encoder that uses whichever filter it likes.
 */
function decodeAlpha(path) {
  const file = readFileSync(path);
  let at = 8;
  let width = 0;
  let height = 0;
  const parts = [];
  while (at < file.length) {
    const length = file.readUInt32BE(at);
    const type = file.toString('ascii', at + 4, at + 8);
    const body = file.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      assert.equal(body[8], 8, `${path}: expected 8 bits per channel`);
      assert.equal(body[9], 6, `${path}: expected RGBA`);
      assert.equal(body[12], 0, `${path}: expected no interlacing`);
    }
    if (type === 'IDAT') parts.push(body);
    at += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * 4;
  const alpha = new Uint8Array(width * height);
  const line = new Uint8Array(stride);
  const previous = new Uint8Array(stride);
  let read = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[read];
    read += 1;
    raw.copy(line, 0, read, read + stride);
    read += stride;
    for (let i = 0; i < stride; i += 1) {
      const left = i >= 4 ? line[i - 4] : 0;
      const up = previous[i];
      const upLeft = i >= 4 ? previous[i - 4] : 0;
      let value = line[i];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        // Paeth: the neighbour the gradient predictor lands nearest to.
        const estimate = left + up - upLeft;
        const dl = Math.abs(estimate - left);
        const du = Math.abs(estimate - up);
        const dul = Math.abs(estimate - upLeft);
        value += dl <= du && dl <= dul ? left : du <= dul ? up : upLeft;
      }
      line[i] = value & 0xff;
    }
    for (let x = 0; x < width; x += 1) alpha[y * width + x] = line[x * 4 + 3];
    previous.set(line);
  }
  return { width, height, alpha };
}

/** The one contiguous run of opaque rows in a column, or `null` when empty. */
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
    assert.notEqual(
      image.alpha[y * image.width + x],
      0,
      `column ${x} has a hole at row ${y}`,
    );
  }
  return { first, height: last - first + 1 };
}

const tileSet = JSON.parse(readFileSync(join(CONTENT, 'tilesets/mvp_terrain.json'), 'utf8'));
const { width, flatHeight, surfaceHeight, elevationHeight } = tileSet.art;
const shoulder = Math.floor(surfaceHeight / 4);
const band = elevationHeight - shoulder;

const elevationAssets = tileSet.tiles.flatMap((tile) =>
  (tile.art?.elevation?.levels ?? []).flatMap((level) =>
    level.variants.map((variant) => variant.asset),
  ),
);
const surfaceAssets = tileSet.tiles.flatMap((tile) =>
  (tile.art?.surface ?? []).map((variant) => variant.asset),
);
const flatAssets = tileSet.tiles.flatMap((tile) =>
  (tile.art?.flat ?? []).map((variant) => variant.asset),
);

test('every shipped image is drawn on the grid its tile set declares', () => {
  assert.ok(elevationAssets.length > 0 && surfaceAssets.length > 0 && flatAssets.length > 0);
  for (const asset of flatAssets) {
    const image = decodeAlpha(join(CONTENT, asset));
    assert.deepEqual(
      [image.width, image.height],
      [width, flatHeight],
      `${asset} is not ${width}x${flatHeight}`,
    );
  }
  for (const asset of surfaceAssets) {
    const image = decodeAlpha(join(CONTENT, asset));
    assert.deepEqual(
      [image.width, image.height],
      [width, surfaceHeight],
      `${asset} is not ${width}x${surfaceHeight}`,
    );
  }
  for (const asset of elevationAssets) {
    const image = decodeAlpha(join(CONTENT, asset));
    assert.deepEqual(
      [image.width, image.height],
      [width, elevationHeight],
      `${asset} is not ${width}x${elevationHeight}`,
    );
  }
});

test('an elevation image fills its band, and never overhangs it', () => {
  for (const asset of elevationAssets) {
    const image = decodeAlpha(join(CONTENT, asset));
    const tops = [];
    for (let x = 0; x < image.width; x += 1) {
      const run = opaqueRun(image, x);
      assert.ok(run !== null, `${asset}: column ${x} draws nothing`);
      // Exactly the band the canvas leaves room for: a taller run cannot fit
      // (the image would have to be taller), and a shorter one leaves a seam
      // where the layer under it starts — whatever the step turns out to be.
      assert.equal(
        run.height,
        band,
        `${asset}: column ${x} is ${run.height} rows, not a ${band}px band`,
      );
      tops.push(run.first);
    }

    // The band follows the hexagon's two lower edges: level at the flanks,
    // deepest under the south vertex, and never jumping more than a row.
    const middle = image.width / 2;
    assert.equal(tops[middle - 1], shoulder, `${asset}: the V is not ${shoulder} deep`);
    assert.equal(tops[middle], shoulder, `${asset}: the V is not ${shoulder} deep`);
    assert.ok(tops[0] <= 1, `${asset}: the band does not start at the west shoulder`);
    assert.ok(
      tops[image.width - 1] <= 1,
      `${asset}: the band does not start at the east shoulder`,
    );
    for (let x = 1; x < image.width; x += 1) {
      const step = tops[x] - tops[x - 1];
      assert.ok(
        Math.abs(step) <= 1 && (x <= middle ? step >= 0 : step <= 0),
        `${asset}: the band's top edge is not the hexagon's, at column ${x}`,
      );
    }
  }
});

/**
 * A flat image is the *untilted* hexagon, which is the whole reason it is not a
 * surface (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`). Two
 * numbers say so and neither is true of a surface: the canvas is `2 / sqrt(3)`
 * as tall as it is wide, and the widest opaque row is the full width of the
 * image, at its own middle.
 */
test('a flat image is the untilted hexagon, not a squashed one', () => {
  assert.equal(
    flatHeight,
    Math.round((width * 2) / Math.sqrt(3)),
    `flatHeight ${flatHeight} is not the untilted hexagon's height for a width of ${width}`,
  );

  for (const asset of flatAssets) {
    const image = decodeAlpha(join(CONTENT, asset));
    const rows = [];
    for (let y = 0; y < image.height; y += 1) {
      let count = 0;
      for (let x = 0; x < image.width; x += 1) {
        if (image.alpha[y * image.width + x] !== 0) count += 1;
      }
      rows.push(count);
    }

    // The shoulders are the full width, and they are where a hexagon puts them:
    // a quarter of the way down and a quarter of the way up.
    const quarter = Math.round(flatHeight / 4);
    assert.equal(rows[quarter], width, `${asset}: row ${quarter} is not the hexagon's full width`);
    assert.equal(
      rows[flatHeight - 1 - quarter],
      width,
      `${asset}: row ${flatHeight - 1 - quarter} is not the hexagon's full width`,
    );
    // And the two vertices are points rather than edges. A few pixels wide, not
    // one: a hexagon's vertex falls between pixel centres, so the extreme row
    // is however much of it a whole row can hold — which is how the shipped
    // surfaces have always been drawn too.
    const point = width / 8;
    assert.ok(rows[0] <= point, `${asset}: the north vertex is ${rows[0]} pixels wide`);
    assert.ok(
      rows[flatHeight - 1] <= point,
      `${asset}: the south vertex is ${rows[flatHeight - 1]} pixels wide`,
    );
  }
});

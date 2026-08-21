#!/usr/bin/env node
/**
 * Puts a generated image on **this project's geometry**.
 *
 * PixelLab draws material — grass, granite, a barrel, a sleeve. It does not
 * draw this engine's hexagons: a flat tile is the untilted pointy-top hexagon
 * on a `width x flatHeight` canvas, a surface is that hexagon squashed to the
 * grid's tilt, and an elevation image is the two side faces *alone*, a band
 * that follows the `V` its lower edges cut
 * (`docs/content-format.md`, ADR-0035/0037/0041). An image that misses any of
 * that fails `scripts/tile-art.test.mjs` — which is the point: the silhouette
 * is a contract, not a preference.
 *
 * So nothing generated lands in `assets/tiles/` directly. It comes through
 * here, where it is scaled to the canvas the tile set declares, made opaque
 * (a hole inside a tile shows the map's background through the ground), and
 * masked to the exact shape the renderer draws.
 *
 * Sprites — characters, objects, UI — have no silhouette to honour, only a box:
 * `sprite` trims the transparent border and reports the `rect` the character
 * definition owes it (ADR-0034).
 *
 * # Usage
 *
 * ```text
 *   conform.mjs flat      <source> <destination> [options]
 *   conform.mjs surface   <source> <destination> [options]
 *   conform.mjs elevation <source> <destination> [options]
 *   conform.mjs sprite    <source> <destination> [options]
 *   conform.mjs inspect   <source>
 * ```
 *
 * `<source>` is an `https://` URL (what every PixelLab tool returns), a `.png`
 * path, or a file holding base64 — which is how an image arrives when the MCP
 * result carried it inline. `<destination>` is a path under the content root
 * (`assets/tiles/grass/flat/grass_a.png`) or an absolute path.
 *
 * | Option | Meaning |
 * |---|---|
 * | `--tile-set <path>` | Geometry source. Default: the only tile set `project.json` declares. |
 * | `--fit cover\|contain\|none` | How the source meets the canvas. Default `cover`. |
 * | `--offset <dx,dy>` | Moves the source inside the canvas, in destination pixels. |
 * | `--fill <#rrggbb>` | Backdrop for tile shapes. Default: the source's most common colour. |
 * | `--size <w>x<h>` | `sprite` only: fit to this box instead of keeping the source size. |
 * | `--no-trim` | `sprite` only: keep the transparent border. |
 * | `--force` | Overwrite an existing destination. |
 *
 * The geometry it used, the fit it applied and the box it wrote are printed, so
 * the numbers that end up in a tile set or a character definition are read off
 * the run rather than guessed.
 */
import { deflateSync, inflateSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { contentDir, describeContentDir } from '../../../../scripts/content-dir.mjs';

/** The defaults `TileArtGeometry` applies when a set declares no `art` block. */
const DEFAULT_GEOMETRY = {
  width: 32,
  flatHeight: 37,
  surfaceHeight: 20,
  elevationHeight: 13,
  elevationStep: 8,
};

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
}

/** Undoes one PNG scanline filter, in place. */
function unfilter(type, line, previous, pixelBytes) {
  for (let i = 0; i < line.length; i += 1) {
    const left = i >= pixelBytes ? line[i - pixelBytes] : 0;
    const up = previous[i];
    const upLeft = i >= pixelBytes ? previous[i - pixelBytes] : 0;
    let value = line[i];
    if (type === 1) value += left;
    else if (type === 2) value += up;
    else if (type === 3) value += (left + up) >> 1;
    else if (type === 4) {
      const p = left + up - upLeft;
      const dl = Math.abs(p - left);
      const du = Math.abs(p - up);
      const dul = Math.abs(p - upLeft);
      value += dl <= du && dl <= dul ? left : du <= dul ? up : upLeft;
    } else if (type !== 0) {
      throw new Error(`unknown PNG filter ${type}`);
    }
    line[i] = value & 0xff;
  }
}

/**
 * Decodes a PNG into `{ width, height, data }`, `data` being RGBA bytes.
 *
 * Eight bits a channel, no interlacing, any of the five colour types — which
 * covers everything the generators return and everything a canvas encoder
 * writes back.
 */
function decodePng(file) {
  if (file.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let width = 0;
  let height = 0;
  let colourType = 6;
  let depth = 8;
  let palette = null;
  let alphaTable = null;
  const parts = [];
  let at = 8;
  while (at < file.length) {
    const length = file.readUInt32BE(at);
    const type = file.toString('ascii', at + 4, at + 8);
    const body = file.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      colourType = body[9];
      if (depth !== 8) throw new Error(`${depth}-bit PNG: only 8 bits a channel are read`);
      if (body[12] !== 0) throw new Error('interlaced PNG');
    } else if (type === 'PLTE') {
      palette = Buffer.from(body);
    } else if (type === 'tRNS') {
      alphaTable = Buffer.from(body);
    } else if (type === 'IDAT') {
      parts.push(body);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + length;
  }

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colourType];
  if (!channels) throw new Error(`unsupported PNG colour type ${colourType}`);
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const data = new Uint8Array(width * height * 4);
  const line = new Uint8Array(stride);
  let previous = new Uint8Array(stride);
  let read = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[read];
    read += 1;
    raw.copy(line, 0, read, read + stride);
    read += stride;
    unfilter(filter, line, previous, channels);
    for (let x = 0; x < width; x += 1) {
      const from = x * channels;
      const to = (y * width + x) * 4;
      if (colourType === 6) {
        data.set(line.subarray(from, from + 4), to);
      } else if (colourType === 2) {
        data.set(line.subarray(from, from + 3), to);
        data[to + 3] = 255;
      } else if (colourType === 0) {
        data[to] = data[to + 1] = data[to + 2] = line[from];
        data[to + 3] = 255;
      } else if (colourType === 4) {
        data[to] = data[to + 1] = data[to + 2] = line[from];
        data[to + 3] = line[from + 1];
      } else {
        const index = line[from];
        data[to] = palette[index * 3];
        data[to + 1] = palette[index * 3 + 1];
        data[to + 2] = palette[index * 3 + 2];
        data[to + 3] = alphaTable && index < alphaTable.length ? alphaTable[index] : 255;
      }
    }
    previous = Uint8Array.from(line);
  }
  return { width, height, data };
}

/** Encodes `{ width, height, data }` as an 8-bit RGBA PNG. */
function encodePng(image) {
  const stride = image.width * 4;
  const raw = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(image.data.buffer, image.data.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Geometry — the same derivation the renderer and the seeder make
// ---------------------------------------------------------------------------

/** A pointy-top hexagon's corners, squashed by `tilt` (1 leaves it untilted). */
function hexagon(width, height, tilt) {
  const size = width / Math.sqrt(3);
  return Array.from({ length: 6 }, (_unused, index) => {
    const angle = (Math.PI / 180) * (60 * index - 30);
    return {
      x: width / 2 + size * Math.cos(angle),
      y: height / 2 + size * Math.sin(angle) * tilt,
    };
  });
}

/** A hexagon's upper and lower outlines, as functions of the column. */
function edges(hex, width) {
  const half = width / 2;
  const lowShoulder = hex[1].y;
  const south = hex[2].y;
  const highShoulder = hex[0].y;
  const north = hex[5].y;
  return {
    front: (x) =>
      x < half
        ? lowShoulder + (x / half) * (south - lowShoulder)
        : south - ((x - half) / half) * (south - lowShoulder),
    back: (x) =>
      x < half
        ? highShoulder - (x / half) * (highShoulder - north)
        : north + ((x - half) / half) * (highShoulder - north),
  };
}

/** The shapes a tile set's `art` block implies. */
function shapesOf(geometry) {
  const { width, flatHeight, surfaceHeight, elevationHeight } = geometry;
  const tilt = (surfaceHeight / width) * (Math.sqrt(3) / 2);
  const top = edges(hexagon(width, surfaceHeight, tilt), width);
  const flat = edges(hexagon(width, flatHeight, 1), width);
  const shoulder = Math.floor(surfaceHeight / 4);
  return {
    top,
    flat,
    shoulder,
    /** How tall the drawn band of an elevation image is. */
    band: elevationHeight - shoulder,
    /** The first row of cut ground at this column: `0` at the flanks, `shoulder` at the south vertex. */
    faceRow: (x) => Math.ceil(top.front(x + 0.5)) - (surfaceHeight - shoulder),
  };
}

// ---------------------------------------------------------------------------
// Pixels
// ---------------------------------------------------------------------------

/** The most common opaque colour in an image, as `[r, g, b]`. */
function modalColour(image) {
  const counts = new Map();
  for (let i = 0; i < image.data.length; i += 4) {
    if (image.data[i + 3] < 128) continue;
    const key = (image.data[i] << 16) | (image.data[i + 1] << 8) | image.data[i + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = 0;
  let seen = -1;
  for (const [key, count] of counts) {
    if (count > seen) {
      seen = count;
      best = key;
    }
  }
  return [(best >> 16) & 0xff, (best >> 8) & 0xff, best & 0xff];
}

/**
 * Draws `source` onto a `width x height` canvas, nearest-neighbour.
 *
 * Nearest and never anything smoother: an interpolated pixel is a colour the
 * artist did not choose, and a set of tiles whose edges are averaged reads as
 * blur the moment two of them meet.
 */
function fitTo(source, width, height, { fit, offset }) {
  const scale =
    fit === 'none'
      ? 1
      : fit === 'contain'
        ? Math.min(width / source.width, height / source.height)
        : Math.max(width / source.width, height / source.height);
  const originX = (width - source.width * scale) / 2 + offset[0];
  const originY = (height - source.height * scale) / 2 + offset[1];
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sy = Math.floor((y + 0.5 - originY) / scale);
    if (sy < 0 || sy >= source.height) continue;
    for (let x = 0; x < width; x += 1) {
      const sx = Math.floor((x + 0.5 - originX) / scale);
      if (sx < 0 || sx >= source.width) continue;
      const from = (sy * source.width + sx) * 4;
      data.set(source.data.subarray(from, from + 4), (y * width + x) * 4);
    }
  }
  return { width, height, data, scale };
}

/** Composites `image` over `colour`, so every pixel is opaque. */
function over(image, colour) {
  for (let i = 0; i < image.data.length; i += 4) {
    const alpha = image.data[i + 3] / 255;
    for (let c = 0; c < 3; c += 1) {
      image.data[i + c] = Math.round(image.data[i + c] * alpha + colour[c] * (1 - alpha));
    }
    image.data[i + 3] = 255;
  }
  return image;
}

/** Clears every pixel `inside` rejects, and makes the rest fully opaque. */
function maskTo(image, inside) {
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const at = (y * image.width + x) * 4;
      if (inside(x, y)) {
        image.data[at + 3] = 255;
      } else {
        image.data[at] = image.data[at + 1] = image.data[at + 2] = image.data[at + 3] = 0;
      }
    }
  }
  return image;
}

/** The box that holds every pixel with any alpha, or `null` for an empty image. */
function alphaBox(image) {
  let left = image.width;
  let top = image.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (image.data[(y * image.width + x) * 4 + 3] === 0) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  return right < 0 ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/** Cuts `box` out of `image`. */
function crop(image, box) {
  const data = new Uint8Array(box.width * box.height * 4);
  for (let y = 0; y < box.height; y += 1) {
    const from = ((y + box.y) * image.width + box.x) * 4;
    data.set(image.data.subarray(from, from + box.width * 4), y * box.width * 4);
  }
  return { width: box.width, height: box.height, data };
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** Reads a source: an `https://` URL, a `.png` file, or a file holding base64. */
async function readSource(source) {
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`${source}: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  const file = readFileSync(resolve(source));
  if (file.readUInt32BE(0) === 0x89504e47) return file;
  const text = file.toString('utf8').replace(/^data:image\/png;base64,/, '').replace(/\s+/g, '');
  return Buffer.from(text, 'base64');
}

/** The tile set whose `art` block the shapes come from. */
function tileSetOf(flag, root) {
  if (flag) return JSON.parse(readFileSync(isAbsolute(flag) ? flag : join(root, flag), 'utf8'));
  const project = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'));
  const sets = project.tileSets ?? [];
  if (sets.length !== 1) {
    throw new Error(
      `${root}/project.json declares ${sets.length} tile sets — name one with --tile-set`,
    );
  }
  return JSON.parse(readFileSync(join(root, sets[0].path), 'utf8'));
}

function parseOptions(argv) {
  const options = {
    fit: 'cover',
    offset: [0, 0],
    fill: null,
    size: null,
    trim: true,
    force: false,
    tileSet: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--fit') {
      options.fit = value;
      i += 1;
    } else if (flag === '--offset') {
      options.offset = value.split(',').map((n) => Number.parseInt(n, 10));
      i += 1;
    } else if (flag === '--fill') {
      options.fill = value;
      i += 1;
    } else if (flag === '--size') {
      const [w, h] = value.split('x').map((n) => Number.parseInt(n, 10));
      options.size = { width: w, height: h };
      i += 1;
    } else if (flag === '--tile-set') {
      options.tileSet = value;
      i += 1;
    } else if (flag === '--no-trim') options.trim = false;
    else if (flag === '--force') options.force = true;
    else throw new Error(`unknown option ${flag}`);
  }
  if (!['cover', 'contain', 'none'].includes(options.fit)) {
    throw new Error(`--fit is cover, contain or none, not ${options.fit}`);
  }
  return options;
}

function parseColour(text) {
  const hex = text.replace('#', '');
  return [0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
}

// ---------------------------------------------------------------------------
// The shapes
// ---------------------------------------------------------------------------

function conformTile(shape, source, geometry, shapes, options) {
  const height =
    shape === 'flat'
      ? geometry.flatHeight
      : shape === 'surface'
        ? geometry.surfaceHeight
        : shapes.band;
  const fitted = fitTo(source, geometry.width, height, options);
  over(fitted, options.fill ? parseColour(options.fill) : modalColour(source));

  if (shape === 'elevation') {
    // The band follows the `V`: every column is slid down by the row its own
    // cut begins on, so the lowest layer of a cliff ends on the hexagon's
    // silhouette instead of on a flat cut (ADR-0041).
    const canvas = {
      width: geometry.width,
      height: geometry.elevationHeight,
      data: new Uint8Array(geometry.width * geometry.elevationHeight * 4),
    };
    for (let x = 0; x < geometry.width; x += 1) {
      const top = shapes.faceRow(x);
      for (let y = 0; y < shapes.band; y += 1) {
        const from = (y * geometry.width + x) * 4;
        const to = ((y + top) * geometry.width + x) * 4;
        canvas.data.set(fitted.data.subarray(from, from + 4), to);
        canvas.data[to + 3] = 255;
      }
    }
    return canvas;
  }

  const outline = shape === 'flat' ? shapes.flat : shapes.top;
  return maskTo(fitted, (x, y) => y >= outline.back(x + 0.5) && y < outline.front(x + 0.5));
}

function conformSprite(source, options) {
  let image = source;
  if (options.size) {
    image = fitTo(source, options.size.width, options.size.height, options);
  }
  if (!options.trim) return image;
  const box = alphaBox(image);
  if (!box) throw new Error('the image is entirely transparent');
  return crop(image, box);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const [shape, source, destination, ...rest] = process.argv.slice(2);

if (!shape || !source || (shape !== 'inspect' && !destination)) {
  console.error(
    'usage: conform.mjs <flat|surface|elevation|sprite> <source> <destination> [options]\n' +
      '       conform.mjs inspect <source>',
  );
  process.exit(2);
}

const options = parseOptions(shape === 'inspect' ? [] : rest);
const dir = contentDir();
const root = dir.path;
const decoded = decodePng(await readSource(source));

if (shape === 'inspect') {
  const box = alphaBox(decoded);
  const colours = new Set();
  for (let i = 0; i < decoded.data.length; i += 4) {
    if (decoded.data[i + 3] > 0) {
      colours.add((decoded.data[i] << 16) | (decoded.data[i + 1] << 8) | decoded.data[i + 2]);
    }
  }
  const [r, g, b] = modalColour(decoded);
  console.log(`${decoded.width}x${decoded.height}, ${colours.size} colours`);
  console.log(`opaque box: ${box ? `${box.width}x${box.height} at ${box.x},${box.y}` : 'empty'}`);
  console.log(`most common colour: #${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`);
  process.exit(0);
}

console.log(describeContentDir(dir));
const target = isAbsolute(destination) ? destination : join(root, destination);
if (existsSync(target) && !options.force) {
  console.error(`${target} exists — pass --force to overwrite it`);
  process.exit(1);
}

let written;
if (shape === 'sprite') {
  written = conformSprite(decoded, options);
} else {
  const tileSet = tileSetOf(options.tileSet, root);
  const geometry = { ...DEFAULT_GEOMETRY, ...(tileSet.art ?? {}) };
  written = conformTile(shape, decoded, geometry, shapesOf(geometry), options);
  console.log(
    `tile set ${tileSet.id}: ${geometry.width}x${geometry.flatHeight} flats, ` +
      `${geometry.width}x${geometry.surfaceHeight} surfaces, ` +
      `${geometry.width}x${geometry.elevationHeight} faces`,
  );
}

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, encodePng(written));
console.log(
  `${shape}: ${decoded.width}x${decoded.height} -> ${written.width}x${written.height}  ${target}`,
);
if (shape === 'sprite') {
  console.log(`rect for a character layer: [x, y, ${written.width}, ${written.height}]`);
}

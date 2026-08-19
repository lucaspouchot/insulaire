#!/usr/bin/env node
/**
 * Draws the shipped tile art: grass surfaces and the dirt elevation ladder.
 *
 * This is a **seeder, not a pipeline**. The fixture in `content/` needs real
 * images for the asset editor and the renderer to be worth looking at, and
 * thirty-two hand-drawn tiles is not a thing to commit to a fixture. So the
 * art is generated once, checked in as ordinary PNGs, and from then on it is
 * ordinary art: the asset editor opens it, paints it and writes it back
 * (`docs/adr/ADR-0035-tile-art-is-authored-and-resolved-by-level.md`). Nothing
 * in the build runs this, and nothing reads it at run time.
 *
 * It is deterministic — one seeded PRNG per image — so re-running it reproduces
 * the same files byte for byte, and a diff means somebody changed the drawing
 * rather than the noise.
 *
 * # What it draws
 *
 * ```text
 *   grass/surfaces/grass_a..h.png                   64x40  the flat top face
 *   dirt/surfaces/dirt_a..h.png                     64x40  ditto, bare earth
 *   dirt/elevation/level_N/dirt_a..h.png            64x26  one course of stone
 * ```
 *
 * One image is **one step of relief**, never a whole column: a tile standing at
 * elevation 3 is levels 1, 2 and 3 stacked by the resolver, which is what makes
 * the sketch's three-course cube come out of three one-course images.
 *
 * An elevation image is the **faces alone** — its first row is the hexagon's
 * lower shoulder line, its top `shoulderDepth` rows are the `V` those edges cut,
 * and everything below that is stone. The top face is never in it: that always
 * comes from the tile's own surface variants, so a raised tile keeps the variety
 * its surfaces give it.
 *
 * # The two faces are drawn twice
 *
 * A pointy-top hexagon exposes a south-west and a south-east face
 * (`docs/adr/ADR-0014-hex-coordinate-model.md`). They are laid out from
 * **separate draws with separate seeds and separate lighting** — never one
 * mirrored into the other — because that is the rule the whole feature rests
 * on, and a generator that cheated here would be teaching the wrong thing to
 * whoever reads it next.
 *
 * Usage: `node scripts/generate-tile-art.mjs [--out <content dir>]`
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

/**
 * The pixel grid these images are drawn on.
 *
 * Must match `art` in the tile set that references them, and the ratios decide
 * the isometric projection: `surfaceHeight / width` is the tilt and
 * `step / width` is one level of relief (ADR-0035). 64 wide is 32's ratios at
 * twice the resolution — the same map, four times the pixels to draw on.
 */
const GRID = { width: 64, surfaceHeight: 40, elevationHeight: 26, step: 16 };

/**
 * How far the hexagon's lower edges fall, shoulders to south vertex.
 *
 * A quarter of the top face's height, exactly — the same derivation
 * `TileArtGeometry::shoulder_depth` makes. It is where an elevation image
 * begins, so its own `y = 0` is `SHOULDER` below the top face's.
 */
const SHOULDER = GRID.surfaceHeight / 4;

/** How many variants of each thing, matching `docs/sketch_grass_and_dirt_asset.png`. */
const VARIANTS = 8;

/** How many explicit dirt elevation levels the sketch lays out. */
const LEVELS = 3;

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * The projected hexagon, in image pixels.
 *
 * Derived rather than typed in: it is the same corner set `HexLayout` produces,
 * squashed by the tilt the grid implies, so the art lands exactly on the shape
 * the renderer draws. With this grid it comes out whole:
 *
 * ```text
 *        (32,0)
 *   (0,10)    (64,10)
 *   (0,30)    (64,30)
 *        (32,40)
 * ```
 */
function hexagon() {
  const size = GRID.width / Math.sqrt(3);
  const tilt = (GRID.surfaceHeight / GRID.width) * (Math.sqrt(3) / 2);
  return Array.from({ length: 6 }, (_unused, index) => {
    const angle = (Math.PI / 180) * (60 * index - 30);
    return {
      x: GRID.width / 2 + size * Math.cos(angle),
      y: GRID.surfaceHeight / 2 + size * Math.sin(angle) * tilt,
    };
  });
}

const HEX = hexagon();

/**
 * The hexagon's lowest y at this column: where the side faces begin.
 *
 * The two lower edges, `(0,30)→(32,40)` and `(32,40)→(64,30)`, read off the
 * corner set rather than written down — this is the line the renderer extrudes
 * from, and a guide drawn by eye is a guide the map disagrees with.
 */
function frontEdge(x) {
  const half = GRID.width / 2;
  const shoulder = HEX[1].y; // the lower-left/right corners: 30 in this grid
  const bottom = HEX[2].y; // the south vertex: 40
  return x < half
    ? shoulder + (x / half) * (bottom - shoulder)
    : bottom - ((x - half) / half) * (bottom - shoulder);
}

/** The hexagon's highest y at this column: where the top face begins. */
function backEdge(x) {
  const half = GRID.width / 2;
  const shoulder = HEX[0].y; // the upper corners: 10
  const top = HEX[5].y; // the north vertex: 0
  return x < half
    ? shoulder - (x / half) * (shoulder - top)
    : top + ((x - half) / half) * (shoulder - top);
}

/** `true` when this pixel is inside the top face. */
function insideTop(x, y) {
  return x >= 0 && x < GRID.width && y >= backEdge(x + 0.5) && y < frontEdge(x + 0.5);
}

// ---------------------------------------------------------------------------
// A canvas
// ---------------------------------------------------------------------------

class Sheet {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4);
  }

  set(x, y, [red, green, blue], alpha = 255) {
    const px = Math.floor(x);
    const py = Math.floor(y);
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) {
      return;
    }
    const at = (py * this.width + px) * 4;
    this.data[at] = red;
    this.data[at + 1] = green;
    this.data[at + 2] = blue;
    this.data[at + 3] = alpha;
  }

  /** `true` when this pixel has been painted. */
  filled(x, y) {
    const px = Math.floor(x);
    const py = Math.floor(y);
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) {
      return false;
    }
    return this.data[(py * this.width + px) * 4 + 3] > 0;
  }
}

/** Mulberry32: five lines, well distributed, and the same everywhere. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A hash of a name, so every image gets its own stable stream of noise. */
function seedOf(name) {
  let hash = 2166136261;
  for (const character of name) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  }
  return hash >>> 0;
}

const pick = (rng, list) => list[Math.floor(rng() * list.length) % list.length];

/** `colour` shifted towards black (negative) or white (positive). */
function shade([red, green, blue], amount) {
  const towards = amount >= 0 ? 255 : 0;
  const mix = Math.abs(amount);
  return [
    Math.round(red + (towards - red) * mix),
    Math.round(green + (towards - green) * mix),
    Math.round(blue + (towards - blue) * mix),
  ];
}

// ---------------------------------------------------------------------------
// Palettes
// ---------------------------------------------------------------------------

const GRASS = {
  deep: [0x3c, 0x5a, 0x1e],
  base: [0x54, 0x78, 0x27],
  mid: [0x68, 0x8f, 0x2e],
  light: [0x80, 0xa8, 0x3a],
  pale: [0x9c, 0xc0, 0x4e],
  lip: [0x6e, 0x51, 0x2e],
  lipDark: [0x4c, 0x37, 0x1f],
};

const EARTH = {
  deep: [0x5d, 0x40, 0x24],
  base: [0x7c, 0x57, 0x30],
  mid: [0x8e, 0x66, 0x38],
  light: [0xa2, 0x79, 0x48],
  pale: [0xbc, 0x96, 0x62],
  grit: [0xcf, 0xb0, 0x7f],
};

/**
 * One course of stone per level: smaller and sunnier at the top, chunkier and
 * deeper further down, the way the sketch reads a cliff.
 *
 * `courses` are the two bands the sixteen-pixel face is split into, and `block`
 * is a nominal width — the joints jitter around it, because masonry laid to a
 * ruler reads as tiling.
 */
const STONE = [
  {
    base: [0x9a, 0x74, 0x44],
    light: [0xc0, 0x92, 0x58],
    dark: [0x6f, 0x50, 0x29],
    mortar: [0x59, 0x40, 0x22],
    courses: [7, 9],
    block: 9,
  },
  {
    base: [0x8a, 0x62, 0x36],
    light: [0xac, 0x7e, 0x46],
    dark: [0x5f, 0x43, 0x22],
    mortar: [0x4c, 0x36, 0x1b],
    courses: [8, 8],
    block: 11,
  },
  {
    base: [0x77, 0x55, 0x2f],
    light: [0x96, 0x70, 0x3c],
    dark: [0x50, 0x38, 0x19],
    mortar: [0x40, 0x2d, 0x15],
    courses: [9, 7],
    block: 13,
  },
];

// ---------------------------------------------------------------------------
// The top face
// ---------------------------------------------------------------------------

/**
 * Fills the hexagon with a shaded base and a speck of noise.
 *
 * The light comes from the upper left, which is the one lighting decision the
 * whole set shares — every face below is lit to agree with it.
 */
function fillTop(sheet, rng, palette) {
  for (let y = 0; y < GRID.surfaceHeight; y += 1) {
    for (let x = 0; x < GRID.width; x += 1) {
      if (!insideTop(x, y)) {
        continue;
      }
      // Back-to-front gradient, plus a gentle lean towards the lit corner.
      const depth = y / GRID.surfaceHeight;
      const lean = (x / GRID.width) * 0.35;
      const roll = rng();
      let colour = palette.base;
      if (depth + lean < 0.55) {
        colour = roll < 0.35 ? palette.light : palette.mid;
      } else if (depth + lean > 1.1) {
        colour = roll < 0.4 ? palette.deep : palette.base;
      } else {
        colour = roll < 0.3 ? palette.mid : palette.base;
      }
      sheet.set(x, y, colour);
    }
  }
}

/** A one-pixel rim: lit along the back edges, darkened along the front ones. */
function rimTop(sheet, palette) {
  for (let x = 0; x < GRID.width; x += 1) {
    for (let y = 0; y < GRID.surfaceHeight; y += 1) {
      if (!insideTop(x, y)) {
        continue;
      }
      const back = !insideTop(x, y - 1);
      const front = !insideTop(x, y + 1);
      if (back) {
        sheet.set(x, y, shade(palette.pale ?? palette.light, 0.1));
      } else if (front) {
        sheet.set(x, y, shade(palette.deep, 0.15));
      }
    }
  }
}

/** Short blades, leaning the way the light falls. */
function blades(sheet, rng, count) {
  for (let i = 0; i < count; i += 1) {
    const x = Math.floor(rng() * GRID.width);
    const y = Math.floor(rng() * GRID.surfaceHeight);
    if (!insideTop(x, y)) {
      continue;
    }
    const colour = pick(rng, [GRASS.light, GRASS.pale, GRASS.mid, GRASS.deep]);
    const height = 1 + Math.floor(rng() * 3);
    const lean = rng() < 0.5 ? 0 : rng() < 0.5 ? -1 : 1;
    for (let step = 0; step < height; step += 1) {
      const bx = x + Math.round((lean * step) / 2);
      const by = y - step;
      if (insideTop(bx, by)) {
        sheet.set(bx, by, colour);
      }
    }
  }
}

/** A four-petal flower, which is as much as five pixels can carry. */
function flower(sheet, x, y, petal, heart) {
  if (!insideTop(x, y)) {
    return;
  }
  for (const [dx, dy] of [
    [0, -1],
    [-1, 0],
    [1, 0],
    [0, 1],
  ]) {
    if (insideTop(x + dx, y + dy)) {
      sheet.set(x + dx, y + dy, petal);
    }
  }
  sheet.set(x, y, heart);
}

/** A rounded stone sitting on the surface, lit from the upper left. */
function pebble(sheet, rng, x, y, radius, palette) {
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius - 1; dx <= radius + 1; dx += 1) {
      // Wider than tall: a sphere seen at the projection's tilt.
      if ((dx * dx) / ((radius + 1) * (radius + 1)) + (dy * dy) / (radius * radius) > 1) {
        continue;
      }
      if (!insideTop(x + dx, y + dy)) {
        continue;
      }
      // An outline all round, so a stone sits on the ground instead of
      // dissolving into it, then lit from the upper left like everything else.
      const rim =
        (dx * dx) / ((radius + 1) * (radius + 1)) + (dy * dy) / (radius * radius) > 0.55;
      const lit = dx + dy < -radius / 2;
      sheet.set(
        x + dx,
        y + dy,
        rim && dy >= 0
          ? shade(palette.deep, -0.15)
          : lit
            ? palette.pale
            : rng() < 0.25
              ? palette.light
              : palette.base,
      );
    }
  }
}

/** A patch of bare earth showing through the turf. */
function scuff(sheet, rng, cx, cy, radius) {
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius - 2; dx <= radius + 2; dx += 1) {
      const inside = (dx * dx) / ((radius + 2) * (radius + 2)) + (dy * dy) / (radius * radius);
      if (inside > 1 || rng() < inside * 0.7) {
        continue;
      }
      if (!insideTop(cx + dx, cy + dy)) {
        continue;
      }
      sheet.set(cx + dx, cy + dy, rng() < 0.3 ? EARTH.light : EARTH.base);
    }
  }
}

/** Grit and small stones, which is what makes bare earth read as earth. */
function speckle(sheet, rng, count) {
  for (let i = 0; i < count; i += 1) {
    const x = Math.floor(rng() * GRID.width);
    const y = Math.floor(rng() * GRID.surfaceHeight);
    if (!insideTop(x, y)) {
      continue;
    }
    const roll = rng();
    sheet.set(x, y, roll < 0.25 ? EARTH.grit : roll < 0.6 ? EARTH.pale : EARTH.deep);
  }
}

// ---------------------------------------------------------------------------
// The side faces
// ---------------------------------------------------------------------------

/**
 * The stone under one of the two visible faces.
 *
 * Called **twice per image, with different seeds**, once for the south-west
 * face and once for the south-east one. Nothing is copied between them: the
 * joints fall in different places and the two sides are lit differently,
 * because the light is fixed and the faces point in different directions. That
 * is ADR-0035's rule, and a generator that mirrored one into the other would be
 * teaching the wrong thing to whoever reads it next.
 *
 * The band is laid out **relative to `frontEdge`**, so each course runs
 * parallel to the hexagon edge above it and the two faces slope apart from the
 * south vertex on their own.
 *
 * @param lit  how the face takes the light: positive for the lit side
 */
function masonry(sheet, rng, from, to, lit, stone) {
  let top = 0;
  stone.courses.forEach((height, index) => {
    // Staggered joints: a course whose joints line up with the one above reads
    // as a grid rather than as stone.
    const joints = new Set([from, to]);
    const stagger = index % 2 === 0 ? 0 : Math.floor(stone.block / 2);
    for (
      let x = from + stagger + Math.floor(rng() * 3);
      x < to - 3;
      x += stone.block - 2 + Math.floor(rng() * 5)
    ) {
      joints.add(x);
    }
    const edges = [...joints].sort((left, right) => left - right);

    for (let block = 0; block < edges.length - 1; block += 1) {
      const left = edges[block];
      const right = edges[block + 1];
      const body = shade(stone.base, lit + (rng() - 0.5) * 0.1);
      const worn = rng() < 0.35;

      for (let x = left; x < right; x += 1) {
        // `frontEdge` is in the top face's space; an elevation image starts at
        // the shoulders, so everything above them is off the top of it.
        const base = Math.round(frontEdge(x + 0.5)) - SHOULDER * 3 + top;
        for (let row = 0; row < height; row += 1) {
          const y = base + row;
          if (y >= sheet.height) {
            break;
          }
          // One pixel of joint per pair of blocks, not two: a joint drawn from
          // both sides doubles into grout, which is what makes generated
          // masonry look generated.
          const joint = x === left;
          if (joint) {
            sheet.set(x, y, stone.mortar);
          } else if (row === height - 1) {
            sheet.set(x, y, stone.mortar);
          } else if (row === 0) {
            sheet.set(x, y, shade(stone.light, lit));
          } else if (row === height - 2) {
            sheet.set(x, y, shade(stone.dark, lit));
          } else if (worn && rng() < 0.12) {
            sheet.set(x, y, shade(stone.dark, lit + 0.12));
          } else {
            sheet.set(x, y, rng() < 0.15 ? shade(body, -0.07) : body);
          }
        }
      }
    }
    top += height;
  });

  // The shadow the earth above casts on the stone: one line, and relief reads.
  for (let x = from; x < to; x += 1) {
    sheet.set(x, Math.round(frontEdge(x + 0.5)) - SHOULDER * 3, shade(stone.mortar, -0.45));
  }
}

/**
 * The band of soil along the front of a flat grass slab.
 *
 * Inside the hexagon, not below it: a surface image is the top face and nothing
 * else, so this is the last few rows of turf reading as the cut edge of the
 * turf rather than a wall hanging off it. A few blades are left dipping into it
 * so the boundary is not a ruled line.
 */
function grassLip(sheet, rng) {
  const depth = 4;
  for (let x = 0; x < GRID.width; x += 1) {
    const edge = Math.round(frontEdge(x + 0.5));
    for (let y = edge - depth; y < edge; y += 1) {
      if (!insideTop(x, y)) {
        continue;
      }
      const row = y - (edge - depth);
      if (row === 0) {
        // Turf overhanging its own soil: broken, not ruled.
        sheet.set(x, y, rng() < 0.4 ? GRASS.deep : GRASS.lip);
      } else if (row === depth - 1) {
        sheet.set(x, y, GRASS.lipDark);
      } else {
        sheet.set(x, y, rng() < 0.25 ? GRASS.lipDark : GRASS.lip);
      }
    }
  }
}

/** A clump of taller grass, which is what keeps a field from reading as noise. */
function tuft(sheet, rng, cx, cy) {
  const width = 3 + Math.floor(rng() * 3);
  for (let dx = -width; dx <= width; dx += 1) {
    const height = 2 + Math.round(Math.cos((dx / width) * 1.2) * 3);
    for (let step = 0; step < height; step += 1) {
      const x = cx + dx;
      const y = cy - step;
      if (!insideTop(x, y)) {
        continue;
      }
      sheet.set(x, y, step === height - 1 ? GRASS.pale : rng() < 0.4 ? GRASS.light : GRASS.mid);
    }
  }
}

// ---------------------------------------------------------------------------
// The images
// ---------------------------------------------------------------------------

/**
 * One grass surface.
 *
 * The eight variants walk the progression the sketch lays out: plain turf, then
 * flowers, then a scuff of bare earth, then stones — so a field drawn with all
 * eight has something to look at without any two tiles being the same.
 */
function grassSurface(variant) {
  const rng = random(seedOf(`grass_${variant}`));
  const sheet = new Sheet(GRID.width, GRID.surfaceHeight);

  fillTop(sheet, rng, GRASS);
  blades(sheet, rng, 300);
  for (let i = 0; i < 5 + (variant % 3); i += 1) {
    tuft(sheet, rng, 8 + Math.floor(rng() * (GRID.width - 16)), 8 + Math.floor(rng() * 26));
  }

  if (variant >= 5) {
    scuff(sheet, rng, 22 + Math.floor(rng() * 20), 16 + Math.floor(rng() * 10), 4 + (variant % 3));
    blades(sheet, rng, 60);
  }
  if (variant === 3 || variant === 4 || variant === 7 || variant === 8) {
    const petal = variant % 2 === 0 ? [0xe8, 0xb8, 0xc8] : [0xe4, 0xe8, 0xd2];
    for (let i = 0; i < 3 + (variant % 3); i += 1) {
      flower(
        sheet,
        6 + Math.floor(rng() * (GRID.width - 12)),
        6 + Math.floor(rng() * (GRID.surfaceHeight - 12)),
        petal,
        [0xe0, 0xc0, 0x54],
      );
    }
  }
  if (variant >= 6) {
    for (let i = 0; i < variant - 5; i += 1) {
      pebble(
        sheet,
        rng,
        14 + Math.floor(rng() * (GRID.width - 28)),
        14 + Math.floor(rng() * (GRID.surfaceHeight - 24)),
        2 + Math.floor(rng() * 2),
        { base: [0x9a, 0x93, 0x86], light: [0xb6, 0xb0, 0xa4], pale: [0xcd, 0xc8, 0xbc], deep: [0x6b, 0x64, 0x59] },
      );
    }
  }

  rimTop(sheet, GRASS);
  grassLip(sheet, rng);
  return sheet;
}

/** One bare-earth surface: what a dirt tile shows when nothing is raised. */
function dirtSurface(variant) {
  const rng = random(seedOf(`dirt_${variant}`));
  const sheet = new Sheet(GRID.width, GRID.surfaceHeight);

  fillTop(sheet, rng, EARTH);
  speckle(sheet, rng, 260);
  for (let i = 0; i < (variant % 4) + (variant >= 6 ? 2 : 0); i += 1) {
    pebble(
      sheet,
      rng,
      12 + Math.floor(rng() * (GRID.width - 24)),
      12 + Math.floor(rng() * (GRID.surfaceHeight - 20)),
      2 + Math.floor(rng() * 2),
      { base: EARTH.pale, light: EARTH.grit, pale: [0xe0, 0xc9, 0xa2], deep: EARTH.deep },
    );
  }
  rimTop(sheet, EARTH);
  return sheet;
}

/**
 * One step of dirt relief: the two faces, and nothing else.
 *
 * No top face — that is the tile's surface, drawn over this by the renderer.
 * The two faces are laid out from two separate streams, so the joints do not
 * line up across the south vertex and neither side is the other one flipped.
 */
function dirtElevation(level, variant) {
  const sheet = new Sheet(GRID.width, GRID.elevationHeight);
  const stone = STONE[level - 1];

  // The light comes from the upper left, so the south-west face catches it and
  // the south-east one is in shadow. Two draws, two seeds, no mirroring.
  masonry(sheet, random(seedOf(`sw_${level}_${variant}`)), 0, GRID.width / 2, 0.07, stone);
  masonry(sheet, random(seedOf(`se_${level}_${variant}`)), GRID.width / 2, GRID.width, -0.14, stone);
  return sheet;
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(typed));
  return Buffer.concat([head, typed, tail]);
}

/** The sheet as an 8-bit RGBA PNG. No filtering: these are tiny images. */
function encodePng(sheet) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(sheet.width, 0);
  header.writeUInt32BE(sheet.height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  const stride = sheet.width * 4;
  const raw = Buffer.alloc((stride + 1) * sheet.height);
  for (let y = 0; y < sheet.height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(sheet.data.buffer, sheet.data.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** `a`, `b`, … the ids the editor proposes for a variant. */
function letter(index) {
  return String.fromCharCode(97 + index);
}

function write(root, path, sheet) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, encodePng(sheet));
  return path;
}

function main() {
  const flag = process.argv.indexOf('--out');
  const root = flag >= 0 ? resolve(process.argv[flag + 1]) : join(REPO, 'content');

  const written = [];
  for (let variant = 1; variant <= VARIANTS; variant += 1) {
    const id = letter(variant - 1);
    written.push(write(root, `assets/tiles/grass/surfaces/grass_${id}.png`, grassSurface(variant)));
    written.push(write(root, `assets/tiles/dirt/surfaces/dirt_${id}.png`, dirtSurface(variant)));
  }
  for (let level = 1; level <= LEVELS; level += 1) {
    for (let variant = 1; variant <= VARIANTS; variant += 1) {
      written.push(
        write(
          root,
          `assets/tiles/dirt/elevation/level_${level}/dirt_${letter(variant - 1)}.png`,
          dirtElevation(level, variant),
        ),
      );
    }
  }

  console.log(`[tile-art] wrote ${written.length} images under ${join(root, 'assets/tiles')}`);
  console.log(
    `[tile-art] grid ${GRID.width}x${GRID.surfaceHeight} surface, ` +
      `${GRID.width}x${GRID.elevationHeight} faces (${SHOULDER} of V), ` +
      `${GRID.step} px per level`,
  );
}

main();

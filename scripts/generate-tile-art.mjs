#!/usr/bin/env node
/**
 * Draws the shipped tile art: a surface set for every terrain the MVP tile set
 * paints with, and the elevation ladders the earth, stone and mountain cliffs
 * are cut from.
 *
 * This is a **seeder, not a pipeline**. The fixture in `content/` needs real
 * images for the asset editor and the renderer to be worth looking at, and a
 * hundred and twenty-eight hand-drawn tiles is not a thing to commit to a
 * fixture. So the art is generated once, checked in as ordinary PNGs, and from
 * then on it is ordinary art: the asset editor opens it, paints it and writes
 * it back (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`).
 * Nothing in the build runs this, and nothing reads it at run time.
 *
 * It is deterministic — one seeded PRNG per image — so re-running it reproduces
 * the same files byte for byte, and a diff means somebody changed the drawing
 * rather than the noise.
 *
 * # What it draws
 *
 * ```text
 *   <terrain>/flat/<terrain>_a..h.png                  64x74  the untilted hexagon
 *   <terrain>/surfaces/<terrain>_a..h.png              64x40  the tilted top face
 *   <terrain>/elevation/level_N/<terrain>_a..h.png     64x26  one step of cliff
 * ```
 *
 * Flats and surfaces for grass, dirt, sand, water, forest, rock and mountain;
 * elevation ladders for dirt, rock and mountain. A tile that authors no ladder
 * of its own borrows one — a grass meadow standing on a rock cliff is a
 * per-cell choice, not a second set of images
 * (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`).
 *
 * # A flat tile is the same drawing on a different outline
 *
 * A top-down world and an isometric one do not show the same hexagon: one is
 * `2 / sqrt(3)` as tall as it is wide, the other is squashed to the grid's
 * tilt. So they get separate images and neither is stretched into the other
 * (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`). What is *not*
 * separate is the drawing: the same painter fills both, from the same seed,
 * with the outline swapped underneath it — grass is grass whichever way the
 * map is drawn, and the only thing the projection decides is where the edge is.
 *
 * One elevation image is **one step of relief**, never a whole column: a tile
 * standing at elevation 3 is levels 1, 2 and 3 stacked by the resolver.
 *
 * An elevation image is the **faces alone** — its first row is the hexagon's
 * lower shoulder line, and its top `SHOULDER` rows are the `V` those edges cut.
 * Below that `V` it draws a band exactly one `step` thick **that follows it**,
 * and leaves the rest of the canvas empty: the canvas is taller only because
 * the `V` has to fit above the band. Filling that spare room would stack just
 * as well, but the lowest layer of a cliff would then end on a flat cut instead
 * of on the hexagon's own silhouette, and would jut past the polygon wall it is
 * meant to cover — which shows at the edge of the map, and beside any neighbour
 * standing higher than the cliff's foot. The top face is never in it: that
 * always comes from the tile's own surface variants, so a raised tile keeps the
 * variety its surfaces give it.
 *
 * # A surface is flat-lit, a face is not
 *
 * Surfaces carry **no gradient and no rim**. A hex tile is laid edge to edge
 * against five others, so any large-scale light-to-dark ramp inside one tile
 * becomes a visible diagonal seam the moment two of them meet, and a shaded
 * border becomes a honeycomb. What is left is material: value-noise mottling at
 * a few pixels' scale, plus whatever grows on it. Relief is drawn by the
 * elevation faces, which is where the light actually has something to model.
 *
 * # The two faces are drawn twice
 *
 * ```text
 *   ┌───────────────┐  ← the lower shoulder line, the image's own row 0
 *   │\             /│
 *   │ \___________/ │  ← the V the hexagon's two lower edges cut
 *   │  \ SW | SE /  │     one step of relief, and nothing more
 *   │   \___|___/   │  ← the same V again, one step down
 *   └───────────────┘
 * ```
 *
 * A pointy-top hexagon exposes a south-west and a south-east face
 * (`docs/adr/ADR-0011-hex-coordinate-model.md`). They are laid out from
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
 * `step / width` is one level of relief (ADR-0026). 64 wide is 32's ratios at
 * twice the resolution — the same map, four times the pixels to draw on.
 */
const GRID = { width: 64, flatHeight: 74, surfaceHeight: 40, elevationHeight: 26, step: 16 };

/**
 * How far the hexagon's lower edges fall, shoulders to south vertex.
 *
 * A quarter of the top face's height, exactly — the same derivation
 * `TileArtGeometry::shoulder_depth` makes. It is where an elevation image
 * begins, so its own `y = 0` is `SHOULDER` below the top face's.
 */
const SHOULDER = GRID.surfaceHeight / 4;

/** The row of a surface image the hexagon's lower shoulders sit on. */
const SHOULDER_LINE = GRID.surfaceHeight - SHOULDER;

/** How many variants of each thing. */
const VARIANTS = 8;

/** How many explicit elevation levels each ladder authors. */
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
 * The untilted hexagon, in a flat image's pixel space.
 *
 * The same corner set, without the tilt: this is the shape a top-down map draws
 * (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`), which is why a
 * flat image is its own picture rather than a surface stretched. With this grid
 * its north vertex is at `y = 0.05` and its south at `73.95`, so the whole
 * hexagon fits the canvas.
 */
function flatHexagon() {
  const size = GRID.width / Math.sqrt(3);
  return Array.from({ length: 6 }, (_unused, index) => {
    const angle = (Math.PI / 180) * (60 * index - 30);
    return {
      x: GRID.width / 2 + size * Math.cos(angle),
      y: GRID.flatHeight / 2 + size * Math.sin(angle),
    };
  });
}

const FLAT_HEX = flatHexagon();

/**
 * A hexagon's upper and lower outlines, as functions of the column.
 *
 * Read off the corner set rather than written down: these are the lines the
 * renderer extrudes from and strokes, and an outline drawn by eye is an outline
 * the map disagrees with. Both projections come through here — only the corners
 * differ.
 *
 * Corner `0` is the upper right, `1` the lower right, `2` the south vertex and
 * `5` the north, which is the order `HexLayout.corners` produces.
 */
function edges(hex) {
  const half = GRID.width / 2;
  const lowShoulder = hex[1].y; // the lower-left/right corners: 30 on the tilted grid
  const south = hex[2].y; //       the south vertex: 40
  const highShoulder = hex[0].y; // the upper corners: 10
  const north = hex[5].y; //       the north vertex: 0
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

/**
 * The shape the surface painters are filling, and how tall its canvas is.
 *
 * A tilted top face and an untilted flat tile are the *same drawing* on a
 * different outline: the material, the noise and everything scattered over it
 * are identical, and only the mask and the canvas height change. So the shape
 * is swapped for the duration of a draw rather than threaded through every
 * painter as a second argument.
 */
const TOP_FIELD = { height: GRID.surfaceHeight, ...edges(HEX) };
const FLAT_FIELD = { height: GRID.flatHeight, ...edges(FLAT_HEX) };
let FIELD = TOP_FIELD;

/** Runs `draw` with `field` in force, and puts the tilted one back after. */
function within(field, draw) {
  FIELD = field;
  try {
    return draw();
  } finally {
    FIELD = TOP_FIELD;
  }
}

/** The hexagon's lowest y at this column: where the side faces begin. */
function frontEdge(x) {
  return TOP_FIELD.front(x);
}

/** `true` when this pixel is inside the shape being filled. */
function insideTop(x, y) {
  return x >= 0 && x < GRID.width && y >= FIELD.back(x + 0.5) && y < FIELD.front(x + 0.5);
}

/**
 * The first row of cut ground in an elevation image, at this column.
 *
 * `frontEdge` is in the top face's space and an elevation image starts at the
 * lower shoulder line, so this is that edge with the shoulder line taken off:
 * `0` at the flanks, `SHOULDER` under the south vertex, which is the `V`.
 *
 * **Ceiling, not rounding.** `insideTop` fills a column up to `frontEdge`
 * exclusive, so the surface's last row is `ceil(frontEdge) - 1` and the cut has
 * to begin on the very next one. Rounding puts it half a pixel out at the
 * flanks, which is a one-pixel seam where a cliff's foot meets the ground in
 * front of it — invisible only as long as something else covers it.
 */
function faceRow(x) {
  return Math.ceil(frontEdge(x + 0.5)) - SHOULDER_LINE;
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
  const mix = Math.min(1, Math.abs(amount));
  return [
    Math.round(red + (towards - red) * mix),
    Math.round(green + (towards - green) * mix),
    Math.round(blue + (towards - blue) * mix),
  ];
}

/**
 * Smooth value noise at `scale` pixels, in `0..1`.
 *
 * This is what makes a fill read as a material instead of as television static,
 * and it is deliberately **small-scale**: blotches a few pixels wide have no
 * direction, so a tile drawn from them still butts against its neighbour
 * without a seam. A large-scale ramp would not, which is the whole reason the
 * surfaces carry no gradient.
 */
function mottle(rng, scale, width, height) {
  const cols = Math.ceil(width / scale) + 2;
  const rows = Math.ceil(height / scale) + 2;
  const grid = Array.from({ length: cols * rows }, () => rng());
  const at = (col, row) => grid[Math.min(rows - 1, row) * cols + Math.min(cols - 1, col)];
  // Cosine interpolation: cheaper than a gradient noise and smooth enough that
  // no blotch shows the lattice it was built on.
  const ease = (t) => (1 - Math.cos(t * Math.PI)) / 2;

  return (x, y) => {
    const cx = Math.floor(x / scale);
    const cy = Math.floor(y / scale);
    const fx = ease(x / scale - cx);
    const fy = ease(y / scale - cy);
    const top = at(cx, cy) * (1 - fx) + at(cx + 1, cy) * fx;
    const bottom = at(cx, cy + 1) * (1 - fx) + at(cx + 1, cy + 1) * fx;
    return top * (1 - fy) + bottom * fy;
  };
}

// ---------------------------------------------------------------------------
// Surface palettes
// ---------------------------------------------------------------------------
//
// Five tones each, darkest first. `fillTop` reads exactly these names, so a new
// terrain is a palette and a decorator rather than a new drawing routine.

const GRASS = {
  deep: [0x3f, 0x5e, 0x22],
  base: [0x55, 0x79, 0x2a],
  mid: [0x66, 0x8c, 0x31],
  light: [0x7b, 0xa2, 0x3b],
  pale: [0x94, 0xb8, 0x4c],
};

const EARTH = {
  deep: [0x63, 0x46, 0x28],
  base: [0x7c, 0x59, 0x33],
  mid: [0x8c, 0x67, 0x3c],
  light: [0x9e, 0x78, 0x4a],
  pale: [0xb6, 0x92, 0x63],
  grit: [0xcd, 0xb0, 0x82],
};

const SAND = {
  deep: [0xb0, 0x94, 0x5c],
  base: [0xc9, 0xaf, 0x76],
  mid: [0xd6, 0xbe, 0x88],
  light: [0xe3, 0xce, 0x9d],
  pale: [0xef, 0xdf, 0xb6],
  grit: [0xa2, 0x84, 0x50],
};

/**
 * Open water. The five tones sit much closer together than any ground
 * palette's, on purpose: mottling is what makes earth read as earth and what
 * makes water read as wet rock. The variation the eye wants here is in the
 * ripples, so the fill only has to carry depth.
 */
const WATER = {
  deep: [0x1a, 0x48, 0x6d],
  base: [0x1f, 0x53, 0x7b],
  mid: [0x24, 0x5c, 0x86],
  light: [0x2a, 0x66, 0x92],
  pale: [0x53, 0x99, 0xc4],
  foam: [0xc2, 0xe3, 0xef],
};

/** The forest floor: grass in shade, before any canopy is drawn over it. */
const UNDERGROWTH = {
  deep: [0x1a, 0x2e, 0x18],
  base: [0x23, 0x3c, 0x1e],
  mid: [0x2a, 0x47, 0x23],
  light: [0x33, 0x55, 0x29],
  pale: [0x3f, 0x66, 0x31],
};

/** A tree crown, lit from the upper left like everything else. */
const CANOPY = {
  deep: [0x24, 0x44, 0x22],
  base: [0x33, 0x5c, 0x2c],
  mid: [0x42, 0x72, 0x34],
  light: [0x55, 0x8b, 0x3f],
  pale: [0x6e, 0xa8, 0x4d],
};

const ROCK = {
  deep: [0x4c, 0x49, 0x45],
  base: [0x67, 0x63, 0x5e],
  mid: [0x79, 0x75, 0x6f],
  light: [0x8f, 0x8a, 0x83],
  pale: [0xa8, 0xa3, 0x9a],
};

const MOUNTAIN = {
  deep: [0x39, 0x38, 0x3e],
  base: [0x4e, 0x4d, 0x54],
  mid: [0x5e, 0x5d, 0x65],
  light: [0x72, 0x71, 0x7a],
  pale: [0x8b, 0x8a, 0x94],
  snow: [0xdd, 0xe3, 0xee],
};

// ---------------------------------------------------------------------------
// The top face
// ---------------------------------------------------------------------------

/**
 * Fills the hexagon with an evenly lit, mottled base.
 *
 * **No gradient, and no rim.** Six of these meet edge to edge on a map: a ramp
 * from one side of a tile to the other reads as a diagonal seam across the
 * whole field, and a darkened border reads as a honeycomb. The variation is
 * value noise at a few pixels' scale plus a per-pixel speck, which has no
 * direction to give away.
 */
function fillTop(sheet, rng, palette) {
  const soft = mottle(rng, 7, GRID.width, FIELD.height);
  const fine = mottle(rng, 3, GRID.width, FIELD.height);
  for (let y = 0; y < FIELD.height; y += 1) {
    for (let x = 0; x < GRID.width; x += 1) {
      if (!insideTop(x, y)) {
        continue;
      }
      const value = soft(x, y) * 0.65 + fine(x, y) * 0.35;
      let colour = palette.base;
      if (value < 0.3) {
        colour = palette.deep;
      } else if (value < 0.45) {
        colour = rng() < 0.5 ? palette.deep : palette.base;
      } else if (value > 0.78) {
        colour = palette.light;
      } else if (value > 0.6) {
        colour = palette.mid;
      }
      sheet.set(x, y, colour);
    }
  }
}

/** Grit, sparks and specks: a per-pixel dusting over whatever is already there. */
function speckle(sheet, rng, count, tones) {
  for (let i = 0; i < count; i += 1) {
    const x = Math.floor(rng() * GRID.width);
    const y = Math.floor(rng() * FIELD.height);
    if (insideTop(x, y)) {
      sheet.set(x, y, pick(rng, tones));
    }
  }
}

/** Short blades, leaning the way the light falls. */
function blades(sheet, rng, count, palette) {
  for (let i = 0; i < count; i += 1) {
    const x = Math.floor(rng() * GRID.width);
    const y = Math.floor(rng() * FIELD.height);
    if (!insideTop(x, y)) {
      continue;
    }
    const colour = pick(rng, [palette.light, palette.pale, palette.mid, palette.deep]);
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

/** A clump of taller grass, which is what keeps a field from reading as noise. */
function tuft(sheet, rng, cx, cy, palette) {
  const width = 3 + Math.floor(rng() * 3);
  for (let dx = -width; dx <= width; dx += 1) {
    const height = 2 + Math.round(Math.cos((dx / width) * 1.2) * 3);
    for (let step = 0; step < height; step += 1) {
      const x = cx + dx;
      const y = cy - step;
      if (!insideTop(x, y)) {
        continue;
      }
      sheet.set(x, y, step === height - 1 ? palette.pale : rng() < 0.4 ? palette.light : palette.mid);
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
      const inside = (dx * dx) / ((radius + 1) * (radius + 1)) + (dy * dy) / (radius * radius);
      if (inside > 1 || !insideTop(x + dx, y + dy)) {
        continue;
      }
      // An outline all round, so a stone sits on the ground instead of
      // dissolving into it, then lit from the upper left like everything else.
      const rim = inside > 0.55;
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

/**
 * An irregular blob of another material: a scuff of earth, a snow patch, a
 * lighter facet of stone.
 *
 * The edge is eaten away in proportion to how far out it is, so the shape is
 * ragged rather than an ellipse somebody drew with a compass.
 */
function patch(sheet, rng, cx, cy, radius, tones) {
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius - 2; dx <= radius + 2; dx += 1) {
      const inside = (dx * dx) / ((radius + 2) * (radius + 2)) + (dy * dy) / (radius * radius);
      if (inside > 1 || rng() < inside * 0.75 || !insideTop(cx + dx, cy + dy)) {
        continue;
      }
      sheet.set(cx + dx, cy + dy, pick(rng, tones));
    }
  }
}

/**
 * A wandering line: a crack in stone, a dry split in clay.
 *
 * It walks rather than being drawn between two points, because a straight
 * fracture reads as a scratch on the lens.
 */
function crack(sheet, rng, x, y, length, colour, glint) {
  let cx = x;
  let cy = y;
  let angle = rng() * Math.PI * 2;
  for (let step = 0; step < length; step += 1) {
    angle += (rng() - 0.5) * 0.9;
    cx += Math.cos(angle);
    cy += Math.sin(angle) * 0.5;
    if (!insideTop(cx, cy)) {
      return;
    }
    sheet.set(cx, cy, colour);
    // A lit lip on the upper side, which is what turns a dark line into a gap.
    if (glint !== undefined && rng() < 0.4 && insideTop(cx, cy - 1)) {
      sheet.set(cx, cy - 1, glint);
    }
  }
}

/**
 * A shallow horizontal arc: a wave on water, a wind ripple in sand.
 *
 * Horizontal on purpose. The projection foreshortens the vertical, so a line
 * that reads as flat-lying has to be wide and shallow.
 */
function ripple(sheet, rng, cx, cy, width, colour, tail) {
  for (let dx = -width; dx <= width; dx += 1) {
    const t = dx / width;
    const y = cy + Math.round(t * t * 2 - 1);
    if (!insideTop(cx + dx, y)) {
      continue;
    }
    // Thinned towards the ends, so a ripple fades out instead of stopping.
    if (rng() < 0.25 + Math.abs(t) * 0.5) {
      continue;
    }
    sheet.set(cx + dx, y, colour);
    if (tail !== undefined && rng() < 0.3 && insideTop(cx + dx, y + 1)) {
      sheet.set(cx + dx, y + 1, tail);
    }
  }
}

/**
 * A tree crown seen from above and slightly in front.
 *
 * Built from three or four overlapping lobes rather than one disc: a canopy is
 * a bundle of branches, and a single ellipse reads as a bush made of plastic.
 * Lit from the upper left, shaded at the lower right, with a bite of shadow
 * under it so it sits on the ground rather than floating over it.
 */
function canopy(sheet, rng, cx, cy, radius, palette) {
  const lobes = Array.from({ length: 3 + Math.floor(rng() * 2) }, () => ({
    x: cx + Math.round((rng() - 0.5) * radius * 1.4),
    y: cy + Math.round((rng() - 0.5) * radius * 0.9),
    r: radius * (0.55 + rng() * 0.45),
  }));

  // The shadow first, so the crown is drawn over its own edge.
  for (let dy = -1; dy <= radius; dy += 1) {
    for (let dx = -radius - 1; dx <= radius + 2; dx += 1) {
      const x = cx + dx + 1;
      const y = cy + dy + Math.round(radius * 0.7);
      const inside = (dx * dx) / ((radius + 1) * (radius + 1)) + (dy * dy) / (radius * radius);
      if (inside <= 1 && insideTop(x, y)) {
        sheet.set(x, y, shade(UNDERGROWTH.deep, -0.25));
      }
    }
  }

  // The outline, one lobe at a time and one pixel wider than the crown: a tree
  // seen from above sits *in* the undergrowth, and without a dark edge the two
  // greens dissolve into one another.
  const rim = shade(palette.deep, -0.4);
  for (const lobe of lobes) {
    const span = Math.ceil(lobe.r) + 2;
    for (let dy = -span; dy <= span; dy += 1) {
      for (let dx = -span - 1; dx <= span + 1; dx += 1) {
        const inside =
          (dx * dx) / ((lobe.r + 1.6) * (lobe.r + 1.6)) + (dy * dy) / ((lobe.r + 0.7) * (lobe.r + 0.7));
        if (inside <= 1 && insideTop(lobe.x + dx, lobe.y + dy)) {
          sheet.set(lobe.x + dx, lobe.y + dy, rim);
        }
      }
    }
  }

  for (const lobe of lobes) {
    const span = Math.ceil(lobe.r) + 1;
    for (let dy = -span; dy <= span; dy += 1) {
      for (let dx = -span - 1; dx <= span + 1; dx += 1) {
        const inside =
          (dx * dx) / ((lobe.r + 1) * (lobe.r + 1)) + (dy * dy) / (lobe.r * lobe.r);
        if (inside > 1) {
          continue;
        }
        const x = lobe.x + dx;
        const y = lobe.y + dy;
        if (!insideTop(x, y)) {
          continue;
        }
        // Distance from the light, not from the lobe: the whole crown has one
        // sun, so the lobes read as one mass rather than as a heap of balls.
        const lit = (x - cx) / radius + ((y - cy) / radius) * 1.1;
        let colour = palette.base;
        if (lit < -0.8) {
          colour = rng() < 0.55 ? palette.pale : palette.light;
        } else if (lit < -0.1) {
          colour = rng() < 0.45 ? palette.light : palette.mid;
        } else if (lit > 0.6) {
          colour = rng() < 0.55 ? palette.deep : palette.base;
        } else {
          colour = rng() < 0.4 ? palette.mid : palette.base;
        }
        // A ragged crown edge, so the silhouette is leaves and not a circle —
        // and the rim already drawn shows through wherever a leaf is missing.
        if (inside > 0.88 && rng() < 0.4) {
          continue;
        }
        sheet.set(x, y, colour);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The side faces
// ---------------------------------------------------------------------------
//
// A face is ground *cut through*, not a wall somebody built. It gets what a cut
// bank actually shows: strata running parallel to the edge above it, erosion
// running down it, stones the size the material carries, and a hard shadow
// where the surface overhangs. What it must not get is coursed blocks — a
// staggered grid of rectangles reads as brickwork, which is a building and not
// a hillside.

/**
 * One step of cut ground, for one of the two visible faces.
 *
 * Called **twice per image, with different seeds**, once for the south-west
 * face and once for the south-east one. Nothing is copied between them: the
 * strata fall in different places and the two sides are lit differently,
 * because the light is fixed and the faces point in different directions. That
 * is ADR-0026's rule, and a generator that mirrored one into the other would be
 * teaching the wrong thing to whoever reads it next.
 *
 * Everything is laid out **relative to `faceRow`**, so each stratum runs
 * parallel to the hexagon edge above it, the two faces slope apart from the
 * south vertex on their own, and the band's lower edge is that same `V` one
 * step down — which is the outline the asset editor's guides mark.
 *
 * @param lit  how the face takes the light: positive for the lit side
 */
function cutFace(sheet, rng, from, to, lit, ground) {
  const step = GRID.step;

  // Erosion: a drifting per-column bias, so the face is grooved by runnels
  // instead of by per-pixel noise. Smoothed, because a random value per column
  // is corduroy.
  const bias = new Float64Array(GRID.width);
  let drift = 0;
  for (let x = from; x < to; x += 1) {
    drift = drift * 0.72 + (rng() - 0.5) * 0.075;
    bias[x] = drift;
  }

  // Strata: bands of a fraction of a step, each wandering a pixel or two along
  // its length. A seam is one dark row with a lit row under it — the ledge the
  // band above leaves — which is what says "layers of ground" without ever
  // closing a rectangle.
  const seams = ground.seams.map((at) => ({
    at,
    phase: rng() * Math.PI * 2,
    sway: 5 + rng() * 9,
    depth: 1.1 + rng() * 1.4,
  }));

  const grain = mottle(rng, 4, GRID.width, GRID.elevationHeight);
  const coarse = mottle(rng, 9, GRID.width, GRID.elevationHeight);

  for (let x = from; x < to; x += 1) {
    const top = faceRow(x);
    const seamRows = seams.map(
      (seam) =>
        top + Math.round(seam.at * step + Math.sin(x / seam.sway + seam.phase) * seam.depth),
    );

    // One step of relief, and not a pixel more: the band's bottom edge follows
    // the same `V` as its top, so a stack meets edge to edge and the lowest
    // layer ends on the hexagon's own silhouette rather than on a flat cut.
    const foot = Math.min(sheet.height, top + step);

    for (let y = top; y < foot; y += 1) {
      const value = coarse(x, y) * 0.6 + grain(x, y) * 0.4;
      let colour = ground.base;
      if (value < 0.34) {
        colour = ground.dark;
      } else if (value > 0.72) {
        colour = ground.light;
      } else if (value > 0.56) {
        colour = ground.mid;
      }

      const seam = seamRows.indexOf(y);
      if (seam >= 0) {
        colour = ground.seam;
      } else if (seamRows.includes(y - 1)) {
        colour = ground.light;
      }

      if (y === top) {
        // The shadow the ground above casts on its own cut: one line, and the
        // relief reads before anything else in the image does.
        colour = shade(ground.seam, -0.5);
      } else if (y === top + 1) {
        colour = shade(ground.dark, -0.2);
      }

      sheet.set(x, y, shade(colour, lit + bias[x]));
    }
  }

  // Stones caught in the cut, and the dust washed out from under them.
  for (let i = 0; i < ground.stones; i += 1) {
    const x = from + 2 + Math.floor(rng() * Math.max(1, to - from - 4));
    const top = faceRow(x);
    const y = top + 3 + Math.floor(rng() * (step - 4));
    const radius = ground.stone === undefined ? 1 : 1 + Math.floor(rng() * ground.stone);
    embed(sheet, rng, x, y, radius, ground, lit);
  }

  // The corner where the two faces meet: one column of shade, because two
  // planes at an angle do not fade into each other.
  if (from > 0) {
    const top = faceRow(from);
    for (let y = top; y < Math.min(sheet.height, top + step); y += 1) {
      sheet.set(from, y, shade(ground.dark, lit - 0.22));
    }
  }
}

/** A stone set into a cut face: darker under, lit on its upper-left shoulder. */
function embed(sheet, rng, cx, cy, radius, ground, lit) {
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius - 1; dx <= radius + 1; dx += 1) {
      const inside = (dx * dx) / ((radius + 1) * (radius + 1)) + (dy * dy) / (radius * radius);
      if (inside > 1) {
        continue;
      }
      const x = cx + dx;
      const y = cy + dy;
      // Inside this step's band, never spilling into the one below it.
      if (x < 0 || x >= sheet.width || y < faceRow(x) + 1 || y >= faceRow(x) + GRID.step) {
        continue;
      }
      const glint = dx + dy <= -radius / 2;
      const colour = glint ? ground.grit : dy >= radius - 1 ? ground.seam : ground.stoneBody;
      sheet.set(x, y, shade(colour, lit));
    }
  }
}

/**
 * Roots hanging out of a topsoil cut.
 *
 * Only the first level gets these: they are what says "this is the ground the
 * grass is standing on" rather than "this is rock", and finding one three
 * courses down would say the opposite.
 */
function roots(sheet, rng, from, to, count, colour, lit) {
  for (let i = 0; i < count; i += 1) {
    let x = from + 1 + Math.floor(rng() * Math.max(1, to - from - 2));
    let y = faceRow(x) + 1;
    const length = 2 + Math.floor(rng() * 4);
    for (let step = 0; step < length; step += 1) {
      y += 1;
      x += rng() < 0.35 ? (rng() < 0.5 ? -1 : 1) : 0;
      if (x < 0 || x >= sheet.width || y < faceRow(x) || y >= faceRow(x) + GRID.step) {
        break;
      }
      sheet.set(x, y, shade(colour, lit));
    }
  }
}

// ---------------------------------------------------------------------------
// Elevation ladders
// ---------------------------------------------------------------------------
//
// Three levels each, top to bottom: what a spade turns, what a pick turns, and
// what neither does. `seams` are where the strata fall inside one step, as
// fractions of it, and `stones` is how many the material carries.

const DIRT_LADDER = [
  {
    name: 'topsoil',
    base: [0x6f, 0x4e, 0x2d],
    mid: [0x80, 0x5c, 0x35],
    light: [0x96, 0x6f, 0x42],
    dark: [0x57, 0x3c, 0x21],
    seam: [0x3f, 0x2a, 0x16],
    grit: [0xb4, 0x92, 0x64],
    stoneBody: [0x8a, 0x74, 0x54],
    seams: [0.14, 0.55],
    stones: 5,
    stone: 2,
    roots: 9,
  },
  {
    name: 'packed earth',
    base: [0x7b, 0x5a, 0x34],
    mid: [0x8c, 0x69, 0x3e],
    light: [0xa2, 0x7d, 0x4d],
    dark: [0x5e, 0x43, 0x25],
    seam: [0x45, 0x2f, 0x18],
    grit: [0xc0, 0xa0, 0x71],
    stoneBody: [0x93, 0x7d, 0x5c],
    seams: [0.28, 0.62, 0.86],
    stones: 8,
    stone: 2,
    roots: 0,
  },
  {
    name: 'subsoil',
    base: [0x6a, 0x54, 0x36],
    mid: [0x78, 0x61, 0x41],
    light: [0x8c, 0x74, 0x50],
    dark: [0x4f, 0x3e, 0x27],
    seam: [0x38, 0x2b, 0x1a],
    grit: [0xac, 0x97, 0x74],
    stoneBody: [0x85, 0x76, 0x60],
    seams: [0.2, 0.46, 0.74],
    stones: 12,
    stone: 3,
    roots: 0,
  },
];

const ROCK_LADDER = [
  {
    name: 'weathered stone',
    base: [0x6d, 0x69, 0x63],
    mid: [0x7c, 0x78, 0x71],
    light: [0x92, 0x8d, 0x85],
    dark: [0x52, 0x4f, 0x4a],
    seam: [0x3b, 0x39, 0x35],
    grit: [0xaf, 0xa9, 0x9f],
    stoneBody: [0x84, 0x7f, 0x77],
    seams: [0.22, 0.58, 0.85],
    stones: 7,
    stone: 2,
    roots: 0,
  },
  {
    name: 'bedded rock',
    base: [0x60, 0x5d, 0x58],
    mid: [0x6e, 0x6a, 0x64],
    light: [0x82, 0x7d, 0x76],
    dark: [0x47, 0x45, 0x41],
    seam: [0x32, 0x30, 0x2d],
    grit: [0x9d, 0x97, 0x8e],
    stoneBody: [0x76, 0x71, 0x6a],
    seams: [0.16, 0.44, 0.72],
    stones: 6,
    stone: 3,
    roots: 0,
  },
  {
    name: 'bedrock',
    base: [0x51, 0x4f, 0x4b],
    mid: [0x5d, 0x5a, 0x56],
    light: [0x6f, 0x6b, 0x65],
    dark: [0x3a, 0x39, 0x36],
    seam: [0x27, 0x26, 0x24],
    grit: [0x87, 0x82, 0x7a],
    stoneBody: [0x64, 0x60, 0x5b],
    seams: [0.34, 0.68],
    stones: 5,
    stone: 3,
    roots: 0,
  },
];

const MOUNTAIN_LADDER = [
  {
    name: 'scree face',
    base: [0x55, 0x54, 0x5b],
    mid: [0x63, 0x62, 0x6a],
    light: [0x78, 0x77, 0x80],
    dark: [0x3e, 0x3d, 0x43],
    seam: [0x2b, 0x2b, 0x30],
    grit: [0xa5, 0xa6, 0xb0],
    stoneBody: [0x6c, 0x6b, 0x74],
    seams: [0.26, 0.64],
    stones: 9,
    stone: 3,
    roots: 0,
  },
  {
    name: 'cliff',
    base: [0x48, 0x47, 0x4e],
    mid: [0x55, 0x54, 0x5c],
    light: [0x67, 0x66, 0x70],
    dark: [0x33, 0x33, 0x38],
    seam: [0x22, 0x22, 0x27],
    grit: [0x8f, 0x90, 0x9c],
    stoneBody: [0x5c, 0x5b, 0x64],
    seams: [0.18, 0.5, 0.8],
    stones: 6,
    stone: 3,
    roots: 0,
  },
  {
    name: 'roots of the mountain',
    base: [0x3a, 0x39, 0x40],
    mid: [0x45, 0x44, 0x4b],
    light: [0x54, 0x53, 0x5b],
    dark: [0x28, 0x28, 0x2d],
    seam: [0x1a, 0x1a, 0x1e],
    grit: [0x76, 0x77, 0x83],
    stoneBody: [0x4a, 0x49, 0x51],
    seams: [0.42],
    stones: 5,
    stone: 3,
    roots: 0,
  },
];

// ---------------------------------------------------------------------------
// The images
// ---------------------------------------------------------------------------

/**
 * One grass surface.
 *
 * The eight variants walk a progression: plain turf, then flowers, then a scuff
 * of bare earth, then stones — so a field drawn with all eight has something to
 * look at without any two tiles being the same.
 *
 * The scuff is on **one** variant, not four. A patch of bare earth is the
 * loudest thing on a green tile, and a field rolling eight variants would show
 * it on every other hex — which reads as damage to the ground rather than as
 * variety. One in eight is a clearing; four in eight is a pattern.
 */
function grassSurface(variant) {
  const rng = random(seedOf(`grass_${variant}`));
  const sheet = new Sheet(GRID.width, FIELD.height);

  fillTop(sheet, rng, GRASS);
  blades(sheet, rng, 320, GRASS);
  for (let i = 0; i < 5 + (variant % 3); i += 1) {
    tuft(sheet, rng, 8 + Math.floor(rng() * (GRID.width - 16)), 8 + Math.floor(rng() * 26), GRASS);
  }

  if (variant === 6) {
    patch(sheet, rng, 22 + Math.floor(rng() * 20), 16 + Math.floor(rng() * 10), 4, [
      EARTH.base,
      EARTH.base,
      EARTH.light,
    ]);
    blades(sheet, rng, 70, GRASS);
  }
  if (variant === 3 || variant === 4 || variant === 7 || variant === 8) {
    const petal = variant % 2 === 0 ? [0xe8, 0xb8, 0xc8] : [0xe4, 0xe8, 0xd2];
    for (let i = 0; i < 3 + (variant % 3); i += 1) {
      flower(
        sheet,
        6 + Math.floor(rng() * (GRID.width - 12)),
        6 + Math.floor(rng() * (FIELD.height - 12)),
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
        14 + Math.floor(rng() * (FIELD.height - 24)),
        2 + Math.floor(rng() * 2),
        ROCK,
      );
    }
  }
  return sheet;
}

/** One bare-earth surface: what a dirt tile shows when nothing is raised. */
function dirtSurface(variant) {
  const rng = random(seedOf(`dirt_${variant}`));
  const sheet = new Sheet(GRID.width, FIELD.height);

  fillTop(sheet, rng, EARTH);
  speckle(sheet, rng, 300, [EARTH.grit, EARTH.pale, EARTH.pale, EARTH.deep]);
  for (let i = 0; i < 1 + (variant % 3); i += 1) {
    crack(
      sheet,
      rng,
      12 + Math.floor(rng() * (GRID.width - 24)),
      12 + Math.floor(rng() * 16),
      6 + Math.floor(rng() * 10),
      shade(EARTH.deep, -0.3),
      EARTH.pale,
    );
  }
  for (let i = 0; i < (variant % 4) + (variant >= 6 ? 2 : 0); i += 1) {
    pebble(
      sheet,
      rng,
      12 + Math.floor(rng() * (GRID.width - 24)),
      12 + Math.floor(rng() * (FIELD.height - 20)),
      2 + Math.floor(rng() * 2),
      { base: EARTH.pale, light: EARTH.grit, pale: [0xe0, 0xc9, 0xa2], deep: EARTH.deep },
    );
  }
  return sheet;
}

/** One stretch of sand: fine grain, wind ripples, the odd shell. */
function sandSurface(variant) {
  const rng = random(seedOf(`sand_${variant}`));
  const sheet = new Sheet(GRID.width, FIELD.height);

  fillTop(sheet, rng, SAND);
  speckle(sheet, rng, 420, [SAND.pale, SAND.light, SAND.deep, SAND.grit]);
  for (let i = 0; i < 3 + (variant % 4); i += 1) {
    ripple(
      sheet,
      rng,
      14 + Math.floor(rng() * (GRID.width - 28)),
      10 + Math.floor(rng() * 22),
      6 + Math.floor(rng() * 8),
      SAND.pale,
      SAND.deep,
    );
  }
  if (variant >= 5) {
    for (let i = 0; i < variant - 4; i += 1) {
      pebble(
        sheet,
        rng,
        14 + Math.floor(rng() * (GRID.width - 28)),
        14 + Math.floor(rng() * (FIELD.height - 24)),
        1 + Math.floor(rng() * 2),
        { base: SAND.deep, light: SAND.light, pale: SAND.pale, deep: SAND.grit },
      );
    }
  }
  return sheet;
}

/** One stretch of open water: swell, glints, and foam on the later variants. */
function waterSurface(variant) {
  const rng = random(seedOf(`water_${variant}`));
  const sheet = new Sheet(GRID.width, FIELD.height);

  fillTop(sheet, rng, WATER);
  for (let i = 0; i < 7 + (variant % 4); i += 1) {
    ripple(
      sheet,
      rng,
      12 + Math.floor(rng() * (GRID.width - 24)),
      6 + Math.floor(rng() * 28),
      5 + Math.floor(rng() * 9),
      WATER.light,
      WATER.deep,
    );
  }
  for (let i = 0; i < 3 + (variant % 3); i += 1) {
    ripple(
      sheet,
      rng,
      12 + Math.floor(rng() * (GRID.width - 24)),
      6 + Math.floor(rng() * 28),
      3 + Math.floor(rng() * 6),
      WATER.pale,
      undefined,
    );
  }
  // Glints: single pixels, because a highlight on water is a point and not a
  // shape. The last variants get foam caps, so a lake has some weather in it.
  speckle(sheet, rng, 40 + variant * 6, [WATER.pale, WATER.pale, WATER.deep]);
  if (variant >= 6) {
    for (let i = 0; i < (variant - 5) * 2; i += 1) {
      ripple(
        sheet,
        rng,
        14 + Math.floor(rng() * (GRID.width - 28)),
        8 + Math.floor(rng() * 24),
        3 + Math.floor(rng() * 4),
        WATER.foam,
        WATER.light,
      );
    }
  }
  return sheet;
}

/** One patch of woodland: undergrowth, then two to four crowns over it. */
function forestSurface(variant) {
  const rng = random(seedOf(`forest_${variant}`));
  const sheet = new Sheet(GRID.width, FIELD.height);

  fillTop(sheet, rng, UNDERGROWTH);
  blades(sheet, rng, 160, UNDERGROWTH);
  for (let i = 0; i < 3; i += 1) {
    tuft(
      sheet,
      rng,
      8 + Math.floor(rng() * (GRID.width - 16)),
      10 + Math.floor(rng() * 24),
      UNDERGROWTH,
    );
  }

  // Two or three crowns, not a thicket: at sixty-four pixels wide a fourth tree
  // stops being a tree and becomes texture. Placed back to front, so a nearer
  // one overlaps a further one.
  const trees = 2 + (variant % 2);
  const spots = Array.from({ length: trees }, () => ({
    x: 15 + Math.floor(rng() * (GRID.width - 30)),
    y: 14 + Math.floor(rng() * (FIELD.height - 26)),
    r: 6 + Math.floor(rng() * 3),
  })).sort((left, right) => left.y - right.y);
  for (const spot of spots) {
    canopy(sheet, rng, spot.x, spot.y, spot.r, CANOPY);
  }
  return sheet;
}

/** One stretch of rocky ground: broken plates, cracks and chips. */
function rockSurface(variant) {
  const rng = random(seedOf(`rock_${variant}`));
  const sheet = new Sheet(GRID.width, FIELD.height);

  fillTop(sheet, rng, ROCK);
  for (let i = 0; i < 3 + (variant % 3); i += 1) {
    patch(
      sheet,
      rng,
      12 + Math.floor(rng() * (GRID.width - 24)),
      12 + Math.floor(rng() * 18),
      3 + Math.floor(rng() * 3),
      [ROCK.light, ROCK.light, ROCK.pale, ROCK.mid],
    );
  }
  for (let i = 0; i < 4 + (variant % 4); i += 1) {
    crack(
      sheet,
      rng,
      10 + Math.floor(rng() * (GRID.width - 20)),
      10 + Math.floor(rng() * 20),
      6 + Math.floor(rng() * 12),
      shade(ROCK.deep, -0.25),
      ROCK.pale,
    );
  }
  speckle(sheet, rng, 150, [ROCK.pale, ROCK.deep, ROCK.light]);
  if (variant >= 5) {
    for (let i = 0; i < variant - 4; i += 1) {
      pebble(
        sheet,
        rng,
        14 + Math.floor(rng() * (GRID.width - 28)),
        14 + Math.floor(rng() * (FIELD.height - 24)),
        2 + Math.floor(rng() * 2),
        ROCK,
      );
    }
  }
  return sheet;
}

/** One mountain shoulder: cold stone, hard facets, snow in the hollows. */
function mountainSurface(variant) {
  const rng = random(seedOf(`mountain_${variant}`));
  const sheet = new Sheet(GRID.width, FIELD.height);

  fillTop(sheet, rng, MOUNTAIN);
  for (let i = 0; i < 3 + (variant % 3); i += 1) {
    patch(
      sheet,
      rng,
      12 + Math.floor(rng() * (GRID.width - 24)),
      12 + Math.floor(rng() * 18),
      3 + Math.floor(rng() * 4),
      [MOUNTAIN.light, MOUNTAIN.mid, MOUNTAIN.pale],
    );
  }
  for (let i = 0; i < 5 + (variant % 4); i += 1) {
    crack(
      sheet,
      rng,
      10 + Math.floor(rng() * (GRID.width - 20)),
      10 + Math.floor(rng() * 20),
      7 + Math.floor(rng() * 12),
      shade(MOUNTAIN.deep, -0.35),
      MOUNTAIN.pale,
    );
  }
  speckle(sheet, rng, 170, [MOUNTAIN.pale, MOUNTAIN.deep, MOUNTAIN.light]);
  // Snow lies on the last three variants only, and in one or two patches —
  // dusted evenly over all eight it stops reading as weather and starts reading
  // as a fault in the palette.
  if (variant >= 6) {
    for (let i = 0; i < variant - 5; i += 1) {
      snow(sheet, rng, 16 + Math.floor(rng() * (GRID.width - 32)), 14 + Math.floor(rng() * 12));
    }
  }
  return sheet;
}

/**
 * A patch of old snow: bright in the middle, blue in its own shadow, with the
 * stone it is lying in darkened along its lower edge.
 *
 * Drawn as a shape rather than sprinkled, because a scatter of white pixels on
 * grey reads as damage to the file.
 */
function snow(sheet, rng, cx, cy) {
  const radius = 3 + Math.floor(rng() * 2);
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius - 2; dx <= radius + 2; dx += 1) {
      const inside = (dx * dx) / ((radius + 2) * (radius + 2)) + (dy * dy) / (radius * radius);
      if (inside > 1 || rng() < inside * inside * 0.9 || !insideTop(cx + dx, cy + dy)) {
        continue;
      }
      const colour =
        dy > radius * 0.35
          ? shade(MOUNTAIN.snow, -0.36)
          : dx + dy < -radius * 0.5
            ? MOUNTAIN.snow
            : rng() < 0.45
              ? shade(MOUNTAIN.snow, -0.18)
              : MOUNTAIN.snow;
      sheet.set(cx + dx, cy + dy, colour);
    }
  }
}

/**
 * One step of cut relief: the two faces, and nothing else.
 *
 * No top face — that is the tile's surface, drawn over this by the renderer.
 * The two faces are laid out from two separate streams, so nothing lines up
 * across the south vertex and neither side is the other one flipped.
 */
function elevation(terrain, ladder, level, variant) {
  const sheet = new Sheet(GRID.width, GRID.elevationHeight);
  const ground = ladder[level - 1];

  // The light comes from the upper left, so the south-west face catches it and
  // the south-east one is in shadow. Two draws, two seeds, no mirroring.
  const west = random(seedOf(`${terrain}_sw_${level}_${variant}`));
  const east = random(seedOf(`${terrain}_se_${level}_${variant}`));
  cutFace(sheet, west, 0, GRID.width / 2, 0.14, ground);
  cutFace(sheet, east, GRID.width / 2, GRID.width, -0.3, ground);
  if (ground.roots > 0) {
    roots(sheet, west, 0, GRID.width / 2, ground.roots, ground.seam, 0.14);
    roots(sheet, east, GRID.width / 2, GRID.width, ground.roots, ground.seam, -0.3);
  }
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

/**
 * What each terrain is drawn from.
 *
 * Only three ladders for seven terrains, on purpose: a cell may draw its faces
 * from another tile's ladder, so a sand shelf is dirt's cut and a grass mesa is
 * rock's — a choice in the map, not another eight images
 * (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`).
 */
const TERRAINS = [
  { id: 'grass', paint: grassSurface },
  { id: 'dirt', paint: dirtSurface, ladder: DIRT_LADDER },
  { id: 'sand', paint: sandSurface },
  { id: 'water', paint: waterSurface },
  { id: 'forest', paint: forestSurface },
  { id: 'rock', paint: rockSurface, ladder: ROCK_LADDER },
  { id: 'mountain', paint: mountainSurface, ladder: MOUNTAIN_LADDER },
];

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
  for (const terrain of TERRAINS) {
    for (let variant = 1; variant <= VARIANTS; variant += 1) {
      const id = letter(variant - 1);
      written.push(
        write(
          root,
          `assets/tiles/${terrain.id}/flat/${terrain.id}_${id}.png`,
          within(FLAT_FIELD, () => terrain.paint(variant)),
        ),
      );
      written.push(
        write(
          root,
          `assets/tiles/${terrain.id}/surfaces/${terrain.id}_${id}.png`,
          within(TOP_FIELD, () => terrain.paint(variant)),
        ),
      );
    }
    if (terrain.ladder === undefined) {
      continue;
    }
    for (let level = 1; level <= LEVELS; level += 1) {
      for (let variant = 1; variant <= VARIANTS; variant += 1) {
        written.push(
          write(
            root,
            `assets/tiles/${terrain.id}/elevation/level_${level}/${terrain.id}_${letter(variant - 1)}.png`,
            elevation(terrain.id, terrain.ladder, level, variant),
          ),
        );
      }
    }
  }

  console.log(`[tile-art] wrote ${written.length} images under ${join(root, 'assets/tiles')}`);
  console.log(
    `[tile-art] grid ${GRID.width}x${GRID.flatHeight} flat, ` +
      `${GRID.width}x${GRID.surfaceHeight} surface, ` +
      `${GRID.width}x${GRID.elevationHeight} faces (${SHOULDER} of V), ` +
      `${GRID.step} px per level`,
  );
}

main();

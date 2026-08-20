/**
 * Resolving a cell to the images that draw it.
 *
 * This is the TypeScript half of `crates/world/src/tile_art.rs`, and it is a
 * **mirror**: the same rules, the same numbers, asserted by the same tests on
 * both sides. It exists for the same reason the hex maths does — resolution
 * runs once per visible cell per frame, and one WASM crossing per tile is the
 * thing `CLAUDE.md` forbids (`docs/adr/ADR-0014-hex-coordinate-model.md` set
 * the precedent, `docs/adr/ADR-0035-tile-art-is-authored-and-resolved-by-level.md`
 * decided what is resolved).
 *
 * What crosses the boundary is the **content**: a tile's `art` arrives on the
 * palette entry, already validated by Rust. Nothing here decides anything about
 * a tile that a validator could have.
 *
 * # Two projections, two sets of images
 *
 * A hexagon seen straight down and the same hexagon seen isometrically are not
 * the same shape, so each view has its own images: `flat` for a top-down world,
 * `surface` plus `elevation` for an isometric one. Neither is ever stretched
 * into the other's shape, and a tile that authors nothing for the projection in
 * force draws its `fallbackColor`
 * (`docs/adr/ADR-0037-a-flat-map-is-drawn-from-flat-art.md`).
 *
 * # An elevation image is the faces, and only the faces
 *
 * A cell's top face always comes from its **surface** variants, at every
 * height, so raising a tile never costs it the variety its surfaces give it.
 *
 * # A cell may choose, and mostly does not
 *
 * Which variant a cell draws is a hash of its coordinates, so a map costs
 * nothing to author. An author who wants one tile to look a particular way
 * overrides that with a {@link CellArt}: this surface, this ladder, this
 * variant. The ids were resolved to indices by Rust when the grid was built, so
 * nothing here searches a variant list by name
 * (`docs/adr/ADR-0036-a-cell-may-choose-its-tile-art.md`).
 *
 * # What resolution never does
 *
 * It chooses an image and says how far **down** it is drawn. It does not
 * rotate, mirror, skew or scale any part of one to make another: the two faces
 * inside an elevation image are pixels an artist drew, and they stay that way.
 */

import {
  ElevationLevel,
  ProjectionMode,
  TileArt,
  TileArtGeometry,
  TileArtVariant,
  TileElevation,
} from '../content/content-types';

/**
 * Most layers {@link resolveTileRender} will stack for one cell.
 *
 * Mirrors `MAX_STACKED_LEVELS`. A drop of two hundred steps is two hundred
 * blits otherwise, and everything past the first few dozen is below the bottom
 * of any viewport.
 */
export const MAX_STACKED_LEVELS = 64;

/** One image to draw for a cell, and how far below its top face it sits. */
export interface ResolvedTileLayer {
  /** The height this layer stands at, 1-based. */
  readonly level: number;
  /** The explicit level whose art draws it; equal to `level` unless repeated. */
  readonly sourceLevel: number;
  /** Path of the image under the content root. */
  readonly asset: string;
  /** Steps of {@link TileArtGeometry.elevationStep} below the cell's top face. */
  readonly drop: number;
}

/**
 * What to draw for one cell, back to front.
 *
 * One of the two projections answers, never both. A top-down world fills
 * {@link flat} alone; an isometric one fills {@link surface} — at every height,
 * not only when the cell is flat — and stacks {@link layers} under it, faces
 * first, lowest to highest.
 */
export interface ResolvedTileRender {
  readonly tileId: string;
  readonly elevation: number;
  /** The untilted hexagon, in a top-down world. Excludes the two below. */
  readonly flat: string | null;
  /** The tilted top face, at any height, in an isometric world. */
  readonly surface: string | null;
  /** The side faces, lowest first. Drawn *under* the surface. */
  readonly layers: readonly ResolvedTileLayer[];
}

/**
 * Nothing is authored for this cell **in this projection**, so the renderer
 * fills its colour instead.
 */
export function isEmptyRender(render: ResolvedTileRender): boolean {
  return render.flat === null && render.surface === null && render.layers.length === 0;
}

const NOTHING: ResolvedTileRender = {
  tileId: '',
  elevation: 0,
  flat: null,
  surface: null,
  layers: [],
};

/**
 * The variant a cell rolls, stable for the life of the map.
 *
 * FNV-1a over the salt and the coordinates — a hash, not an RNG, so the same
 * cell always answers the same thing and no seed has to travel with the map.
 * Byte for byte the same as `variant_roll` in Rust; the mirrored tests say so.
 *
 * @param salt what is being rolled; pass the tile id, so repainting a cell
 *   rerolls it
 */
export function variantRoll(col: number, row: number, salt: string): number {
  let hash = saltHash(salt);
  for (const value of [col, row]) {
    // The same four little-endian bytes Rust hashes, for negative values too.
    const bits = value | 0;
    for (let shift = 0; shift < 32; shift += 8) {
      hash = Math.imul(hash ^ ((bits >>> shift) & 0xff), PRIME);
    }
  }
  return hash >>> 0;
}

const PRIME = 16777619;

/**
 * The hash of a salt alone, before any coordinate is mixed in.
 *
 * Memoised because the salt is a tile id and the coordinates are not: a map
 * rolls the same dozen ids across every visible cell of every frame, and
 * walking a string's bytes each time was one allocation and one loop per cell
 * for an answer that never changes. The rolled value is untouched — this is
 * the same FNV-1a state, resumed rather than recomputed.
 */
const saltHashes = new Map<string, number>();

function saltHash(salt: string): number {
  const cached = saltHashes.get(salt);
  if (cached !== undefined) {
    return cached;
  }
  let hash = 2166136261;
  // Rust hashes the salt's UTF-8 bytes, so this does too — a tile id is ASCII
  // in practice, and "in practice" is not what a mirrored hash may rest on.
  for (const byte of utf8(salt)) {
    hash = Math.imul(hash ^ byte, PRIME);
  }
  saltHashes.set(salt, hash);
  return hash;
}

/** The UTF-8 bytes of a string, the way Rust's `str::as_bytes` sees it. */
function utf8(text: string): number[] {
  const bytes: number[] = [];
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0;
    if (point < 0x80) {
      bytes.push(point);
    } else if (point < 0x800) {
      bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
    } else if (point < 0x10000) {
      bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
    } else {
      bytes.push(
        0xf0 | (point >> 18),
        0x80 | ((point >> 12) & 0x3f),
        0x80 | ((point >> 6) & 0x3f),
        0x80 | (point & 0x3f),
      );
    }
  }
  return bytes;
}

/** The variant `roll` selects out of `count`, or `null` when there is none. */
export function variantIndex(roll: number, count: number): number | null {
  return count <= 0 ? null : roll % count;
}

/** The explicit levels a tile authors, defaulted. */
function levelsOf(elevation: TileElevation | undefined): readonly ElevationLevel[] {
  return elevation?.levels ?? [];
}

/** `true` when a tile authors no relief, so it falls back to flat colour. */
export function hasElevationArt(art: TileArt | undefined): boolean {
  return levelsOf(art?.elevation).some((level) => (level.variants?.length ?? 0) > 0);
}

/**
 * The explicit level, 1-based, whose art draws `level`.
 *
 * The whole repeat rule, and deliberately total: a rule naming a level nobody
 * authored falls back to the highest explicit one rather than drawing a hole.
 * Validation reports the rule separately, so the author is told without the
 * picture breaking.
 */
export function sourceLevel(elevation: TileElevation | undefined, level: number): number | null {
  const levels = levelsOf(elevation);
  const count = levels.length;
  if (count === 0 || level <= 0) {
    return null;
  }
  if (level <= count) {
    return level;
  }

  const repeat = elevation?.repeat ?? null;
  let source = count;
  if (repeat !== null && 'level' in repeat) {
    source = repeat.level;
  } else if (repeat !== null && 'pattern' in repeat) {
    const usable = repeat.pattern.filter((entry) => entry >= 1 && entry <= count);
    source = usable.length === 0 ? count : (usable[(level - count - 1) % usable.length] as number);
  }
  return source >= 1 && source <= count ? source : count;
}

/**
 * What one authored cell asks for, instead of what the roll would give it.
 *
 * Mirrors `CellArt` in `crates/world/src/tile_art.rs`. An absent field is "roll
 * it", so `{}` — the default — is the ordinary cell
 * (`docs/adr/ADR-0036-a-cell-may-choose-its-tile-art.md`).
 */
export interface CellArt {
  /**
   * Which variant draws the cell's own footprint.
   *
   * One index for both projections: it picks out of the tile's `surface` list
   * in an isometric world and out of its `flat` list in a top-down one,
   * wrapping when the two are different lengths.
   */
  readonly surface?: number | null;
  /**
   * The art whose elevation ladder cuts the faces.
   *
   * How a meadow stands on a rock cliff: the top face stays the tile's own
   * grass, and only the ladder comes from somewhere else.
   */
  readonly elevation?: TileArt | null;
  /**
   * Which of a level's variants draws each layer; absent follows the surface,
   * so a cell's cut matches the ground standing on it.
   */
  readonly elevationVariant?: number | null;
}

/**
 * What to draw for a cell of `art` standing at `elevation` over `base`.
 *
 * `projection` decides which set of images answers, and the two never mix: a
 * top-down world is one flat image and nothing else, and a tile that authors
 * none resolves to nothing so the renderer fills its colour
 * (`docs/adr/ADR-0037-a-flat-map-is-drawn-from-flat-art.md`).
 *
 * `base` is the height the cell's side faces reach down to — the lower of its
 * two front neighbours, which is what the renderer already computes so a cliff
 * is extruded exactly as far as it is visible. `cell` is whatever the author
 * chose by hand; `{}` is the ordinary case, where everything is rolled.
 *
 * In an isometric world the stack runs from `base + 1` to `elevation`, one
 * layer per visible step, and each layer's `drop` is how many steps below the
 * top face it sits. When nothing is visible the surface image is the whole
 * answer.
 */
export function resolveTileRender(
  tileId: string,
  art: TileArt | undefined,
  projection: ProjectionMode,
  elevation: number,
  base: number,
  roll: number,
  cell: CellArt = {},
): ResolvedTileRender {
  if (art === undefined) {
    return { ...NOTHING, tileId, elevation };
  }
  // A top-down hexagon has no tilt and no side faces, so it has its own images
  // and borrows nothing from the isometric ones.
  if (projection !== 'isometric') {
    const index = cell.surface ?? variantIndex(roll, art.flat?.length ?? 0);
    return { tileId, elevation, flat: assetAt(art.flat, index), surface: null, layers: [] };
  }
  const steps = Math.min(Math.max(0, elevation - base), MAX_STACKED_LEVELS);
  // The top face is the tile's own, at every height: an elevation image is the
  // faces and nothing else.
  const surfaceIndex = cell.surface ?? variantIndex(roll, art.surface?.length ?? 0);
  const surface = assetAt(art.surface, surfaceIndex);

  // The faces may come from another tile's ladder; the top face never does.
  const faces = cell.elevation ?? art;

  if (steps === 0 || !hasElevationArt(faces)) {
    return { tileId, elevation, flat: null, surface, layers: [] };
  }

  // The cut follows the ground standing on it: unless the author says
  // otherwise, every layer takes the variant the surface took, so a cell
  // showing `grass_f` is undercut by `dirt_f` all the way down.
  const chosen = cell.elevationVariant ?? surfaceIndex ?? roll;

  const levels = levelsOf(faces.elevation);
  const layers: ResolvedTileLayer[] = [];
  for (let drop = steps - 1; drop >= 0; drop -= 1) {
    // A cell dug below the ground it fronts still needs its faces drawn, and
    // levels at or below zero have no art of their own, so they borrow level 1's.
    const level = Math.max(1, elevation - drop);
    const source = sourceLevel(faces.elevation, level);
    if (source === null) {
      continue;
    }
    const asset = assetAt(levels[source - 1]?.variants, chosen);
    if (asset === null) {
      continue;
    }
    layers.push({ level, sourceLevel: source, asset, drop });
  }

  return { tileId, elevation, flat: null, surface, layers };
}

/**
 * The asset at `index`, wrapped into range.
 *
 * Total, so no caller drops a layer because a surface list and a level's list
 * have different lengths.
 */
function assetAt(
  variants: readonly TileArtVariant[] | undefined,
  index: number | null,
): string | null {
  const count = variants?.length ?? 0;
  if (index === null || count === 0) {
    return null;
  }
  return variants?.[index % count]?.asset ?? null;
}

/**
 * The projection an authored pixel grid implies, as a fraction of the hex.
 *
 * A tile set that ships art is the authority on how a hex is shaped on screen:
 * its surface image *is* the top face, and its step *is* one level of relief.
 * Deriving the projection from it rather than the other way round is what stops
 * a sprite tile and a colour-filled tile disagreeing on the same map — every
 * consumer still asks {@link Projection}, and hit-testing, culling and the wall
 * bases keep working by construction
 * (`docs/adr/ADR-0035-tile-art-is-authored-and-resolved-by-level.md`).
 *
 * ```text
 *   drawn hex width  = sqrt(3) * hexSize            (HexLayout)
 *   tilt             = surfaceHeight / width * (hexWidth / hexHeight)
 *   elevation step   = elevationStep / width * hexWidth
 * ```
 */
export function projectionRatiosOf(geometry: TileArtGeometry): {
  tilt: number;
  elevationRatio: number;
} {
  const width = Math.max(1, geometry.width);
  const SQRT3 = Math.sqrt(3);
  return {
    // hexWidth / hexHeight is sqrt(3) / 2 for a pointy-top hexagon.
    tilt: (geometry.surfaceHeight / width) * (SQRT3 / 2),
    // As a fraction of the circumradius, which is what `Projection` wants.
    elevationRatio: (geometry.elevationStep / width) * SQRT3,
  };
}

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
 * # An elevation image is the faces, and only the faces
 *
 * A cell's top face always comes from its **surface** variants, at every
 * height, so raising a tile never costs it the variety its surfaces give it.
 *
 * # What resolution never does
 *
 * It chooses an image and says how far **down** it is drawn. It does not
 * rotate, mirror, skew or scale any part of one to make another: the two faces
 * inside an elevation image are pixels an artist drew, and they stay that way.
 */

import {
  ElevationLevel,
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
 * The faces first, lowest to highest, then the top face over them — which is
 * why {@link surface} is filled in at every height rather than only when the
 * cell is flat.
 */
export interface ResolvedTileRender {
  readonly tileId: string;
  readonly elevation: number;
  /** The top face, at any height. `null` only when the tile authors none. */
  readonly surface: string | null;
  /** The side faces, lowest first. Drawn *under* the surface. */
  readonly layers: readonly ResolvedTileLayer[];
}

/** Nothing is authored for this cell: the renderer fills its colour instead. */
export function isEmptyRender(render: ResolvedTileRender): boolean {
  return render.surface === null && render.layers.length === 0;
}

const NOTHING: ResolvedTileRender = {
  tileId: '',
  elevation: 0,
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
  const PRIME = 16777619;
  let hash = 2166136261;
  // Rust hashes the salt's UTF-8 bytes, so this does too — a tile id is ASCII
  // in practice, and "in practice" is not what a mirrored hash may rest on.
  for (const byte of utf8(salt)) {
    hash = Math.imul(hash ^ byte, PRIME);
  }
  for (const value of [col, row]) {
    // The same four little-endian bytes Rust hashes, for negative values too.
    const bits = value | 0;
    for (let shift = 0; shift < 32; shift += 8) {
      hash = Math.imul(hash ^ ((bits >>> shift) & 0xff), PRIME);
    }
  }
  return hash >>> 0;
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
 * What to draw for a cell of `art` standing at `elevation` over `base`.
 *
 * `base` is the height the cell's side faces reach down to — the lower of its
 * two front neighbours, which is what the renderer already computes so a cliff
 * is extruded exactly as far as it is visible.
 *
 * The stack runs from `base + 1` to `elevation`, one layer per visible step,
 * and each layer's `drop` is how many steps below the top face it sits. When
 * nothing is visible the surface image is the whole answer.
 */
export function resolveTileRender(
  tileId: string,
  art: TileArt | undefined,
  elevation: number,
  base: number,
  roll: number,
): ResolvedTileRender {
  if (art === undefined) {
    return { ...NOTHING, tileId, elevation };
  }
  const steps = Math.min(Math.max(0, elevation - base), MAX_STACKED_LEVELS);
  // The top face is the tile's own, at every height: an elevation image is the
  // faces and nothing else.
  const surface = pick(art.surface, roll);

  if (steps === 0 || !hasElevationArt(art)) {
    return { tileId, elevation, surface, layers: [] };
  }

  const levels = levelsOf(art.elevation);
  const layers: ResolvedTileLayer[] = [];
  for (let drop = steps - 1; drop >= 0; drop -= 1) {
    // A cell dug below the ground it fronts still needs its faces drawn, and
    // levels at or below zero have no art of their own, so they borrow level 1's.
    const level = Math.max(1, elevation - drop);
    const source = sourceLevel(art.elevation, level);
    if (source === null) {
      continue;
    }
    // Rolling with the level as well as the cell is what stops a tall cliff
    // repeating one rock face all the way down.
    const asset = pick(levels[source - 1]?.variants, (roll + level) >>> 0);
    if (asset === null) {
      continue;
    }
    layers.push({ level, sourceLevel: source, asset, drop });
  }

  return { tileId, elevation, surface, layers };
}

function pick(variants: readonly TileArtVariant[] | undefined, roll: number): string | null {
  const index = variantIndex(roll, variants?.length ?? 0);
  return index === null ? null : (variants?.[index]?.asset ?? null);
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

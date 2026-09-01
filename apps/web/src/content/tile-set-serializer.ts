/**
 * Canonical serialisation of a {@link TileSetDefinition}.
 *
 * The same job `world-serializer.ts` does for a map, for the file the asset
 * editor writes. A tile set is read far more often than it is written — it is
 * the palette every map references — so the layout is chosen for a diff: one
 * tile per block, one **image per line**, and the fields in a fixed order so
 * that adding a variant shows up as one added line rather than a reshuffle.
 *
 * ```json
 * "art": {
 *   "flat": [
 *     { "id": "a", "asset": "assets/tiles/grass_flat_a.png" }
 *   ],
 *   "surface": [
 *     { "id": "a", "asset": "assets/tiles/grass_a.png" }
 *   ],
 *   "elevation": {
 *     "levels": [
 *       { "variants": [{ "id": "a", "asset": "assets/tiles/cliff_a.png" }] }
 *     ],
 *     "repeat": { "level": 1 }
 *   }
 * }
 * ```
 *
 * The format is specified in `docs/content-format.md`, and the shipped
 * `content/tilesets/mvp_terrain.json` is written this way, so an exported set
 * diffs cleanly against a hand-edited one. See `canonical-json.ts` for the
 * layout these tables are read by.
 */

import { blockOf, canonicalJson, list, rowOf, Shape } from './canonical-json';
import {
  ELEVATION_LEVEL_ABSENT,
  ElevationLevel,
  TILE_ABSENT,
  TILE_ART_ABSENT,
  TILE_ELEVATION_ABSENT,
  TILE_SET_ABSENT,
  TileArt,
  TileArtGeometry,
  TileArtVariant,
  TileDefinition,
  TileElevation,
  TileSetDefinition,
} from './generated/tile-set';
import { tileArtGeometry } from './tile-set-geometry';

/** One image of a tile, on one line. */
const VARIANT: Shape<TileArtVariant> = {
  fields: { id: 'always', asset: 'always' },
};

const variants = (images: readonly TileArtVariant[]) =>
  list(images.map((image) => rowOf(image, VARIANT)));

const LEVEL: Shape<ElevationLevel> = {
  absent: ELEVATION_LEVEL_ABSENT,
  fields: {
    name: 'unless-redundant',
    variants: { write: 'always', as: variants },
  },
};

const ELEVATION: Shape<TileElevation> = {
  absent: TILE_ELEVATION_ABSENT,
  fields: {
    levels: {
      write: (elevation) => elevation.levels.length > 0,
      as: (levels) => list(levels.map((level) => blockOf(level, LEVEL))),
    },
    repeat: 'unless-redundant',
  },
};

const ART: Shape<TileArt> = {
  absent: TILE_ART_ABSENT,
  fields: {
    flat: { write: 'unless-redundant', as: variants },
    surface: { write: 'unless-redundant', as: variants },
    elevation: { write: 'unless-redundant', as: (elevation) => blockOf(elevation, ELEVATION) },
  },
};

/** Whether a tile authors any art at all, or falls back to flat colour. */
function draws(tile: TileDefinition): boolean {
  const art = tile.art;
  return (
    (art?.flat ?? []).length > 0 ||
    (art?.surface ?? []).length > 0 ||
    (art?.elevation?.levels ?? []).length > 0 ||
    art?.elevation?.repeat !== undefined
  );
}

/** One tile: what it is, then the images that draw it. */
const TILE: Shape<TileDefinition> = {
  absent: TILE_ABSENT,
  fields: {
    id: 'always',
    name: 'unless-redundant',
    terrain: 'always',
    movementCost: 'always',
    tags: 'always',
    visual: 'always',
    art: { write: draws, as: (art) => blockOf(art, ART) },
  },
};

/** The grid every image in the set is authored on. */
const GEOMETRY: Shape<TileArtGeometry> = {
  fields: {
    width: 'always',
    flatHeight: 'always',
    surfaceHeight: 'always',
    elevationHeight: 'always',
    elevationStep: 'always',
  },
};

/** The tile set file, field by field, in the order it states them. */
const TILE_SET: Shape<TileSetDefinition> = {
  absent: TILE_SET_ABSENT,
  fields: {
    id: 'always',
    schemaVersion: 'always',
    name: 'unless-redundant',
    // Written from the set rather than read off it: a file that names none
    // still states the grid its images were drawn on.
    art: { write: 'always', as: (_, tileSet) => blockOf(tileArtGeometry(tileSet), GEOMETRY) },
    tiles: { write: 'always', as: (tiles) => list(tiles.map((tile) => blockOf(tile, TILE))) },
  },
};

/** Serialises a tile set in the canonical layout. */
export function serializeTileSet(tileSet: TileSetDefinition): string {
  return canonicalJson(blockOf(tileSet, TILE_SET));
}

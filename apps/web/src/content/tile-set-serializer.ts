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
 * diffs cleanly against a hand-edited one.
 */

import {
  ElevationLevel,
  TileArt,
  TileArtVariant,
  TileDefinition,
  TileSetDefinition,
  tileArtGeometry,
} from './content-types';
import { formatValue, inlineObject } from './world-serializer';

/** Serialises a tile set in the canonical layout. */
export function serializeTileSet(tileSet: TileSetDefinition): string {
  const geometry = tileArtGeometry(tileSet);
  const lines: string[] = [
    '{',
    `  "id": ${JSON.stringify(tileSet.id)},`,
    `  "schemaVersion": ${JSON.stringify(tileSet.schemaVersion)},`,
  ];
  if (tileSet.name !== undefined && tileSet.name.length > 0) {
    lines.push(`  "name": ${JSON.stringify(tileSet.name)},`);
  }
  lines.push('  "art": {');
  lines.push(`    "width": ${geometry.width},`);
  lines.push(`    "flatHeight": ${geometry.flatHeight},`);
  lines.push(`    "surfaceHeight": ${geometry.surfaceHeight},`);
  lines.push(`    "elevationHeight": ${geometry.elevationHeight},`);
  lines.push(`    "elevationStep": ${geometry.elevationStep}`);
  lines.push('  },');

  lines.push('  "tiles": [');
  tileSet.tiles.forEach((tile, index) => {
    lines.push(...tileBlock(tile, index === tileSet.tiles.length - 1));
  });
  lines.push('  ]');
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

function tileBlock(tile: TileDefinition, last: boolean): string[] {
  const lines = ['    {'];
  lines.push(`      "id": ${JSON.stringify(tile.id)},`);
  if (tile.name !== undefined && tile.name.length > 0) {
    lines.push(`      "name": ${JSON.stringify(tile.name)},`);
  }
  lines.push(`      "terrain": ${JSON.stringify(tile.terrain)},`);
  lines.push(`      "movementCost": ${JSON.stringify(tile.movementCost)},`);
  lines.push(`      "tags": ${formatValue(tile.tags ?? [])},`);

  const art = artBlock(tile.art);
  const visualTrailer = art.length > 0 ? ',' : '';
  lines.push(`      "visual": ${inlineObject(tile.visual)}${visualTrailer}`);
  lines.push(...art);

  lines.push(last ? '    }' : '    },');
  return lines;
}

/** The `art` member of one tile, or nothing when the tile declares none. */
function artBlock(art: TileArt | undefined): string[] {
  const flat = art?.flat ?? [];
  const surface = art?.surface ?? [];
  const levels = art?.elevation?.levels ?? [];
  const repeat = art?.elevation?.repeat ?? null;
  if (flat.length === 0 && surface.length === 0 && levels.length === 0 && repeat === null) {
    return [];
  }

  const lines = ['      "art": {'];
  const members: string[][] = [];
  if (flat.length > 0) {
    members.push(['        "flat": [', ...variantLines(flat, '          '), '        ]']);
  }
  if (surface.length > 0) {
    members.push(['        "surface": [', ...variantLines(surface, '          '), '        ]']);
  }
  if (levels.length > 0 || repeat !== null) {
    const elevation = ['        "elevation": {'];
    const inner: string[][] = [];
    if (levels.length > 0) {
      inner.push(['          "levels": [', ...levelLines(levels), '          ]']);
    }
    if (repeat !== null) {
      inner.push([`          "repeat": ${inlineObject(repeat)}`]);
    }
    elevation.push(...joinMembers(inner));
    elevation.push('        }');
    members.push(elevation);
  }
  lines.push(...joinMembers(members));
  lines.push('      }');
  return lines;
}

function levelLines(levels: readonly ElevationLevel[]): string[] {
  return levels.flatMap((level, index) => {
    const block = ['            {'];
    if (level.name !== undefined && level.name.length > 0) {
      block.push(`              "name": ${JSON.stringify(level.name)},`);
    }
    block.push('              "variants": [');
    block.push(...variantLines(level.variants ?? [], '                '));
    block.push('              ]');
    block.push(index === levels.length - 1 ? '            }' : '            },');
    return block;
  });
}

function variantLines(variants: readonly TileArtVariant[], indent: string): string[] {
  return variants.map(
    (variant, index) =>
      `${indent}${inlineObject(variant)}${index === variants.length - 1 ? '' : ','}`,
  );
}

/** Joins blocks with a comma after every one but the last. */
function joinMembers(members: readonly string[][]): string[] {
  return members.flatMap((block, index) => {
    if (index === members.length - 1) {
      return block;
    }
    const last = block.length - 1;
    return block.map((line, at) => (at === last ? `${line},` : line));
  });
}

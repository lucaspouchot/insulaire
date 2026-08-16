/**
 * Canonical serialisation of a {@link WorldDefinition}.
 *
 * `JSON.stringify(world, null, 2)` is valid but spreads every placed tile over
 * four lines, which makes a painted map unreadable in review. This writer keeps
 * one record per line:
 *
 * ```json
 * "tiles": [
 *   { "at": [4, 1], "tile": "mountain" },
 *   { "at": [5, 1], "tile": "mountain" }
 * ]
 * ```
 *
 * The format is specified in `docs/content-format.md`, and
 * `content/worlds/demo_world.json` is written the same way — so a world exported
 * from the editor diffs cleanly against a hand-edited one.
 */

import { WorldDefinition } from './content-types';

/** Keys written before the record arrays, in this order. */
const SCALAR_KEYS = [
  'id',
  'schemaVersion',
  'name',
  'width',
  'height',
  'orientation',
  'projection',
  'tileSetId',
  'defaultTile',
] as const;

/** Serialises a world definition in the canonical layout. */
export function serializeWorld(world: WorldDefinition): string {
  const lines: string[] = ['{'];

  for (const key of SCALAR_KEYS) {
    const value = world[key];
    if (value !== undefined) {
      lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
    }
  }

  lines.push(...recordArray('tiles', world.tiles ?? []));
  lines.push(...recordArray('entities', world.entities ?? []));
  lines.push(...recordArray('locations', world.locations ?? []));
  lines.push(...metadataBlock(world.metadata ?? {}));

  lines.push('}');
  return `${lines.join('\n')}\n`;
}

function recordArray(key: string, records: readonly object[]): string[] {
  if (records.length === 0) {
    return [`  ${JSON.stringify(key)}: [],`];
  }
  const lines = [`  ${JSON.stringify(key)}: [`];
  records.forEach((record, index) => {
    const comma = index < records.length - 1 ? ',' : '';
    lines.push(`    ${inlineObject(record)}${comma}`);
  });
  lines.push('  ],');
  return lines;
}

function metadataBlock(metadata: Record<string, unknown>): string[] {
  const entries = Object.entries(metadata).filter(([, value]) => value !== undefined);
  if (entries.length === 0) {
    return ['  "metadata": {}'];
  }
  const lines = ['  "metadata": {'];
  entries.forEach(([key, value], index) => {
    const comma = index < entries.length - 1 ? ',' : '';
    lines.push(`    ${JSON.stringify(key)}: ${formatValue(value)}${comma}`);
  });
  lines.push('  }');
  return lines;
}

/** `{ "at": [4, 1], "tile": "mountain" }` — one record, one line. */
function inlineObject(record: object): string {
  const parts = Object.entries(record)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${JSON.stringify(key)}: ${formatValue(value)}`);
  return `{ ${parts.join(', ')} }`;
}

/**
 * Like `JSON.stringify`, but puts a space after commas inside arrays so
 * coordinates read as `[4, 10]` rather than `[4,10]`.
 */
function formatValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => JSON.stringify(item)).join(', ')}]`;
  }
  return JSON.stringify(value);
}

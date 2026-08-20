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

import { ProjectDefinition, WorldDefinition } from './content-types';

/** Keys written before the record arrays, in this order. */
const SCALAR_KEYS = [
  'id',
  'schemaVersion',
  'name',
  'zone',
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
  lines.push(...recordArray('links', world.links ?? []));
  lines.push(...metadataBlock(world.metadata ?? {}));

  lines.push('}');
  return `${lines.join('\n')}\n`;
}

/**
 * Serialises a project manifest in the same one-record-per-line layout.
 *
 * The editor writes this file whenever the set of maps changes, so a delivered
 * bundle can be produced from exported content alone
 * (`docs/adr/ADR-0018-client-delivery-build.md`).
 */
export function serializeProject(project: ProjectDefinition): string {
  const lines = [
    '{',
    `  "id": ${JSON.stringify(project.id)},`,
    `  "schemaVersion": ${JSON.stringify(project.schemaVersion)},`,
  ];
  if (project.name !== undefined) {
    lines.push(`  "name": ${JSON.stringify(project.name)},`);
  }
  lines.push(`  "startWorld": ${JSON.stringify(project.startWorld)},`);
  lines.push(...recordArray('zones', project.zones ?? []));
  lines.push(...recordArray('tileSets', project.tileSets));

  lines.push(...recordArray('worlds', project.worlds));
  // Only written when the project ships characters: a manifest that has never
  // seen one should not grow an empty array on its first unrelated save.
  if (project.characters !== undefined && project.characters.length > 0) {
    lines.push(...recordArray('characters', project.characters));
  }
  if (project.titleScreen !== undefined) {
    lines.push(`  "titleScreen": ${inlineObject(project.titleScreen)},`);
  }
  if (project.settings !== undefined) {
    lines.push(`  "settings": ${inlineObject(project.settings)},`);
  }
  lines.push(...localesBlock(project.locales));

  // The last entry carries no comma, whichever block it turned out to be.
  const last = lines.length - 1;
  lines[last] = (lines[last] as string).replace(/,$/, '');

  lines.push('}');
  return `${lines.join('\n')}\n`;
}

/**
 * The `locales` block: one language per line, its files inline.
 *
 * Written out even when empty, because a project that lost its languages by
 * export would lose every screen's text with them
 * (`docs/adr/ADR-0023-localised-content-keys.md`).
 */
function localesBlock(locales: ProjectDefinition['locales']): string[] {
  const languages = locales?.languages ?? [];
  if (languages.length === 0) {
    return ['  "locales": { "default": "", "languages": [] },'];
  }

  const lines = ['  "locales": {'];
  lines.push(`    "default": ${JSON.stringify(locales?.default ?? languages[0]?.id ?? '')},`);
  lines.push('    "languages": [');
  languages.forEach((language, index) => {
    const comma = index < languages.length - 1 ? ',' : '';
    lines.push(`      ${inlineObject(language)}${comma}`);
  });
  lines.push('    ]');
  lines.push('  },');
  return lines;
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
export function inlineObject(record: object): string {
  const parts = Object.entries(record)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${JSON.stringify(key)}: ${formatValue(value)}`);
  return parts.length === 0 ? '{}' : `{ ${parts.join(', ')} }`;
}

/**
 * Like `JSON.stringify`, but spaced the way the rest of these files are:
 * coordinates read as `[4, 10]` rather than `[4,10]`, and a nested record as
 * `{ "surface": "f" }` rather than `{"surface":"f"}`.
 */
export function formatValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => formatValue(item)).join(', ')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    return inlineObject(value);
  }
  return JSON.stringify(value);
}

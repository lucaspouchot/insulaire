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
 * from the editor diffs cleanly against a hand-edited one. See
 * `canonical-json.ts` for the layout these tables are read by.
 *
 * A map states what it was given rather than what it means: every scalar the
 * definition holds is written, defaults included, because a world file is the
 * record of an authored map and an author who set the grid to its default set
 * it. What is dropped is what the definition does not hold at all.
 */

import {
  block,
  blockOf,
  canonicalJson,
  list,
  member,
  Node,
  row,
  Shape,
  value,
} from './canonical-json';
import { LocalesDefinition, PROJECT_ABSENT, ProjectDefinition } from './generated/project';
import { MapShape, WORLD_ABSENT, WorldDefinition, WorldMetadata } from './generated/world';

/** A list of records, one to a line. */
const records = (entries: readonly object[]) => list(entries.map((entry) => value(entry)));

/**
 * The `shape` block: one carved — or drawn — cell per line.
 *
 * Written the same way `tiles` is, and for the same reason: a coastline is
 * edited hex by hex, so a diff should show which hexes moved rather than one
 * reflowed line (`docs/adr/ADR-0033-a-map-is-a-set-of-hexes.md`). Omitted
 * entirely when the map is the full rectangle it used to be.
 */
const SHAPE: Shape<MapShape> = {
  fields: {
    default: 'when-present',
    exceptions: { write: 'always', as: (cells) => list(cells.map((cell) => value(cell))) },
  },
};

function carved(world: WorldDefinition): boolean {
  return (world.shape?.exceptions ?? []).length > 0;
}

/** Whatever the map carries, one entry per line. */
function metadata(entries: WorldMetadata): Node {
  return block(
    Object.entries(entries)
      .filter(([, held]) => held !== undefined)
      .map(([key, held]) => member(key, value(held))),
  );
}

/** The world file, field by field, in the order it states them. */
const WORLD: Shape<WorldDefinition> = {
  absent: WORLD_ABSENT,
  fields: {
    id: 'always',
    schemaVersion: 'always',
    name: 'when-present',
    zone: 'when-present',
    origin: 'when-present',
    width: 'always',
    height: 'always',
    orientation: 'when-present',
    projection: 'when-present',
    characterHeightTiles: 'when-present',
    grid: 'when-present',
    reveal: 'when-present',
    tileSetId: 'always',
    defaultTile: 'always',
    shape: { write: carved, as: (shape) => blockOf(shape, SHAPE) },
    tiles: { write: 'always', as: records },
    entities: { write: 'always', as: records },
    decorations: { write: 'always', as: records },
    locations: { write: 'always', as: records },
    links: { write: 'always', as: records },
    metadata: { write: 'always', as: metadata },
  },
};

/** Serialises a world definition in the canonical layout. */
export function serializeWorld(world: WorldDefinition): string {
  return canonicalJson(blockOf(world, WORLD));
}

/**
 * The `locales` block: one language per line, its files inline.
 *
 * Written out even when empty, because a project that lost its languages by
 * export would lose every screen's text with them
 * (`docs/adr/ADR-0020-localised-content-keys.md`).
 */
function locales(declared: LocalesDefinition): Node {
  const languages = declared.languages ?? [];
  if (languages.length === 0) {
    return row([member('default', value('')), member('languages', value([]))]);
  }
  return block([
    member('default', value(declared.default ?? languages[0]?.id ?? '')),
    member('languages', records(languages)),
  ]);
}

/**
 * The project manifest, in the same one-record-per-line layout.
 *
 * The editor writes this file whenever the set of maps changes, so a delivered
 * bundle can be produced from exported content alone
 * (`docs/adr/ADR-0015-client-delivery-build.md`). A list it has never held —
 * characters, decorations, objects — stays out of the file rather than growing
 * an empty array on its first unrelated save.
 */
const PROJECT: Shape<ProjectDefinition> = {
  absent: PROJECT_ABSENT,
  fields: {
    id: 'always',
    schemaVersion: 'always',
    name: 'when-present',
    startWorld: 'always',
    zones: { write: 'always', as: records },
    tileSets: { write: 'always', as: records },
    worlds: { write: 'always', as: records },
    characters: { write: 'unless-redundant', as: records },
    decorations: { write: 'unless-redundant', as: records },
    objects: { write: 'unless-redundant', as: records },
    characterCreation: 'unless-redundant',
    titleScreen: 'unless-redundant',
    settings: 'unless-redundant',
    locales: { write: 'always', as: locales },
  },
};

/** Serialises a project manifest in the canonical layout. */
export function serializeProject(project: ProjectDefinition): string {
  return canonicalJson(blockOf(project, PROJECT));
}

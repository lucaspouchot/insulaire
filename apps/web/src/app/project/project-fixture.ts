/**
 * A small project the project specs drive: one tile set, two maps, one zone.
 *
 * Shared rather than copied because four specs now cover what one used to, and
 * a fixture that drifts between them would let two modules agree with their own
 * spec and disagree with each other.
 *
 * Not a `.spec.ts` file: `tsconfig.spec.json` seeds the program from specs only,
 * and a helper it imports has to be reachable as an ordinary module. Nothing in
 * the application imports it.
 */

import { ProjectDefinition } from '../../content/generated/project';
import { TileSetDefinition } from '../../content/generated/tile-set';
import { WorldDefinition } from '../../content/generated/world';

export const TILE_SET: TileSetDefinition = {
  id: 'terrain',
  schemaVersion: 1,
  name: 'Terrain',
  tiles: [
    {
      id: 'grass',
      name: 'Grass',
      terrain: 'grass',
      movementCost: 1,
      visual: { visualId: 'terrain.grass', fallbackColor: '#4a7c3f' },
    },
    {
      id: 'water',
      name: 'Water',
      terrain: 'water',
      movementCost: 0,
      visual: { visualId: 'terrain.water', fallbackColor: '#2f6f9f' },
    },
  ],
};

/** A four-by-four map of grass with the player on it. */
export function world(id: string): WorldDefinition {
  return {
    id,
    schemaVersion: 1,
    name: id,
    width: 4,
    height: 4,
    orientation: 'pointy',
    tileSetId: 'terrain',
    defaultTile: 'grass',
    tiles: [],
    entities: [{ id: 'p', templateId: 'player', at: [0, 0] }],
    locations: [],
    links: [],
    metadata: { updatedAt: '2026-01-01T00:00:00.000Z' },
  };
}

export const PROJECT: ProjectDefinition = {
  id: 'p',
  schemaVersion: 1,
  name: 'P',
  startWorld: 'valley',
  zones: [{ id: 'valley', name: 'Valley' }],
  tileSets: [{ id: 'terrain', path: 'tilesets/terrain.json' }],
  worlds: [
    { id: 'valley', path: 'worlds/valley.json' },
    { id: 'ridge', path: 'worlds/ridge.json' },
  ],
};

/**
 * Serves the manifest, the tile set and two maps, as the dev server would.
 *
 * The caller is responsible for `vi.unstubAllGlobals()`.
 */
export function contentFiles(project: ProjectDefinition): Map<string, unknown> {
  return new Map<string, unknown>([
    ['content/project.json', project],
    ['content/tilesets/terrain.json', TILE_SET],
    ['content/worlds/valley.json', world('valley')],
    ['content/worlds/ridge.json', world('ridge')],
  ]);
}

/** A `fetch` that answers from `files`, keyed by path under the document base. */
export function fetchFrom(
  files: ReadonlyMap<string, unknown>,
): (input: string) => Promise<Response> {
  return (input: string) => {
    // `assetUrl` resolves against the document base, so what arrives here is
    // absolute; the path is the part these fixtures are keyed by.
    const url = new URL(String(input), 'http://localhost/').pathname.replace(/^\/+/, '');
    const body = files.get(url);
    return Promise.resolve(
      body === undefined
        ? new Response('missing', { status: 404 })
        : new Response(JSON.stringify(body), { status: 200 }),
    );
  };
}

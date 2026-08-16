import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { TileSetDefinition, WorldDefinition } from './content-types';
import { WorldDocument } from './world-document';
import { serializeWorld } from './world-serializer';

// Vitest runs with `apps/web` as its root, so the repository root is two levels up.
const repoRoot = resolve(process.cwd(), '../..');

function readText(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readText(relativePath)) as T;
}

describe('serializeWorld', () => {
  it('writes one record per line', () => {
    const json = serializeWorld({
      id: 'w',
      schemaVersion: 1,
      name: 'W',
      width: 2,
      height: 2,
      orientation: 'pointy',
      tileSetId: 't',
      defaultTile: 'grass',
      tiles: [{ at: [0, 1], tile: 'water' }],
      entities: [{ id: 'p', templateId: 'player', at: [0, 0] }],
      locations: [],
      metadata: { author: 'tests' },
    });

    expect(json).toContain('    { "at": [0, 1], "tile": "water" }\n');
    expect(json).toContain('    { "id": "p", "templateId": "player", "at": [0, 0] }\n');
    expect(json).toContain('  "locations": [],\n');
    expect(json.endsWith('\n')).toBe(true);
  });

  it('produces JSON that parses back to the same value', () => {
    const world: WorldDefinition = {
      id: 'w',
      schemaVersion: 1,
      name: 'Round Trip',
      width: 3,
      height: 3,
      orientation: 'pointy',
      tileSetId: 't',
      defaultTile: 'grass',
      tiles: [
        { at: [0, 0], tile: 'water' },
        { at: [2, 2], tile: 'rock' },
      ],
      entities: [{ id: 'p', templateId: 'player', at: [1, 1], tags: ['hero'] }],
      locations: [{ id: 'l', at: [0, 2], name: 'Here', tags: ['a', 'b'] }],
      metadata: { author: 'tests', description: 'quotes " and \\ backslashes' },
    };

    expect(JSON.parse(serializeWorld(world))).toEqual(world);
  });

  it('handles an empty metadata block', () => {
    const json = serializeWorld({
      id: 'w',
      schemaVersion: 1,
      width: 1,
      height: 1,
      tileSetId: 't',
      defaultTile: 'grass',
    });
    expect(json).toContain('  "metadata": {}\n');
    expect(() => JSON.parse(json)).not.toThrow();
  });

  /**
   * The point of a canonical writer: a world exported from the editor is
   * byte-identical to the same world checked into `content/`, so authored files
   * and exported files diff cleanly against each other.
   */
  it('reproduces the shipped demo world byte for byte', () => {
    const tileSet = readJson<TileSetDefinition>('content/tilesets/mvp_terrain.json');
    const original = readText('content/worlds/demo_world.json');
    const definition = JSON.parse(original) as WorldDefinition;

    const document = WorldDocument.fromDefinition(definition, tileSet);
    const exported = serializeWorld(
      document.toDefinition(() => new Date(definition.metadata?.updatedAt as string)),
    );

    expect(exported).toBe(original);
  });
});

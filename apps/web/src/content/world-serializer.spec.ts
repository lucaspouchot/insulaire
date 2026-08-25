import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ProjectDefinition, TileSetDefinition, WorldDefinition } from './content-types';
import { WorldDocument } from './world-document';
import { serializeProject, serializeWorld } from './world-serializer';

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

  it('writes a cell art choice inline, spaced like everything else', () => {
    const json = serializeWorld({
      id: 'w',
      schemaVersion: 2,
      name: 'W',
      width: 2,
      height: 2,
      orientation: 'pointy',
      tileSetId: 't',
      defaultTile: 'grass',
      tiles: [{ at: [0, 1], tile: 'grass', art: { surface: 'f', elevationTile: 'rock' } }],
      entities: [],
      locations: [],
      metadata: {},
    });

    expect(json).toContain(
      '    { "at": [0, 1], "tile": "grass", "art": { "surface": "f", "elevationTile": "rock" } }\n',
    );
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
      links: [{ id: 'door', at: [2, 0], targetWorld: 'inside', targetAt: [1, 1], name: 'Door' }],
      metadata: { author: 'tests', description: 'quotes " and \\ backslashes' },
    };

    expect(JSON.parse(serializeWorld(world))).toEqual(world);
  });

  it('writes a link as one line', () => {
    const json = serializeWorld({
      id: 'w',
      schemaVersion: 1,
      width: 4,
      height: 4,
      tileSetId: 't',
      defaultTile: 'grass',
      links: [{ id: 'door', at: [1, 2], targetWorld: 'house', targetAt: [0, 3] }],
    });

    expect(json).toContain(
      '    { "id": "door", "at": [1, 2], "targetWorld": "house", "targetAt": [0, 3] }\n',
    );
  });

  it('writes the zone next to the name, and only when there is one', () => {
    const base = {
      id: 'w',
      schemaVersion: 1,
      name: 'W',
      width: 1,
      height: 1,
      tileSetId: 't',
      defaultTile: 'grass',
    } as const;

    expect(serializeWorld({ ...base, zone: 'Northern Reach' })).toContain(
      '  "name": "W",\n  "zone": "Northern Reach",\n',
    );
    expect(serializeWorld(base)).not.toContain('"zone"');
  });

  it('writes the map character scale next to its projection', () => {
    const json = serializeWorld({
      id: 'w',
      schemaVersion: 2,
      width: 1,
      height: 1,
      projection: 'isometric',
      characterHeightTiles: 2.5,
      tileSetId: 't',
      defaultTile: 'grass',
    });

    expect(json).toContain(
      '  "projection": "isometric",\n  "characterHeightTiles": 2.5,\n',
    );
  });

  it('writes a custom shape one carved hex per line, and omits a full one', () => {
    const base = {
      id: 'w',
      schemaVersion: 4,
      name: 'W',
      width: 6,
      height: 6,
      tileSetId: 't',
      defaultTile: 'grass',
    } as const;

    const full = serializeWorld(base);
    expect(full).not.toContain('"shape"');
    expect(full).not.toContain('"origin"');

    const shaped = serializeWorld({
      ...base,
      origin: [0, -2],
      shape: { default: 'absent', exceptions: [[3, 0], [4, 0]] },
    });
    // A coordinate reads the way every other coordinate in these files does.
    expect(shaped).toContain('  "origin": [0, -2],\n');
    expect(shaped).toContain(
      '  "shape": {\n    "default": "absent",\n    "exceptions": [\n      [3, 0],\n      [4, 0]\n    ]\n  },\n',
    );
  });

  it('writes the authored grid appearance next to the map presentation', () => {
    const json = serializeWorld({
      id: 'w',
      schemaVersion: 3,
      width: 1,
      height: 1,
      projection: 'isometric',
      grid: { lineWidth: 3, color: '#336699', alpha: 0.6 },
      tileSetId: 't',
      defaultTile: 'grass',
    });

    expect(json).toContain(
      '  "projection": "isometric",\n  "grid": {"lineWidth":3,"color":"#336699","alpha":0.6},\n',
    );
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

  /**
   * Same guarantee for the second shipped map: the one reached through a door,
   * so the link round-trips through the editor's document model too.
   */
  it('reproduces the shipped refuge byte for byte', () => {
    const tileSet = readJson<TileSetDefinition>('content/tilesets/mvp_terrain.json');
    const original = readText('content/worlds/demo_refuge.json');
    const definition = JSON.parse(original) as WorldDefinition;

    const document = WorldDocument.fromDefinition(definition, tileSet);
    const exported = serializeWorld(
      document.toDefinition(() => new Date(definition.metadata?.updatedAt as string)),
    );

    expect(exported).toBe(original);
  });
});

describe('serializeProject', () => {
  it('reproduces the shipped project manifest byte for byte', () => {
    const original = readText('content/project.json');
    const project = JSON.parse(original) as ProjectDefinition;

    expect(serializeProject(project)).toBe(original);
  });
});

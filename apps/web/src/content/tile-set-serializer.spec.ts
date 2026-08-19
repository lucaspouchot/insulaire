import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TileSetDefinition } from './content-types';
import { serializeTileSet } from './tile-set-serializer';

/**
 * The claim this file makes is the one that matters for an editor that writes
 * content: **what it exports is what is checked in.** A tile set saved from the
 * asset editor has to come back byte for byte identical to the shipped file, or
 * every unrelated save produces a diff nobody asked for
 * (`docs/adr/ADR-0022-authoring-content-workspace.md`).
 */
describe('serializeTileSet', () => {
  const repoRoot = resolve(process.cwd(), '../..');
  const shippedPath = resolve(repoRoot, 'content/tilesets/mvp_terrain.json');

  it('reproduces the shipped tile set byte for byte', () => {
    const shipped = readFileSync(shippedPath, 'utf8');
    const parsed = JSON.parse(shipped) as TileSetDefinition;

    expect(serializeTileSet(parsed)).toBe(shipped);
  });

  it('writes one image per line, and omits art a tile does not declare', () => {
    const written = serializeTileSet({
      id: 'demo',
      schemaVersion: 2,
      name: 'Demo',
      art: { width: 32, surfaceHeight: 20, elevationHeight: 28, elevationStep: 8 },
      tiles: [
        {
          id: 'plain',
          terrain: 'grass',
          movementCost: 1,
          visual: { visualId: 'terrain.grass', fallbackColor: '#4a7c3f' },
        },
        {
          id: 'cliff',
          terrain: 'rock',
          movementCost: 2,
          tags: ['difficult'],
          visual: { visualId: 'terrain.rock', fallbackColor: '#8a8078' },
          art: {
            surface: [
              { id: 'a', asset: 'assets/tiles/cliff_top_a.png' },
              { id: 'b', asset: 'assets/tiles/cliff_top_b.png' },
            ],
            elevation: {
              levels: [{ variants: [{ id: 'a', asset: 'assets/tiles/cliff_a.png' }] }],
              repeat: { level: 1 },
            },
          },
        },
      ],
    });

    expect(written).toContain('      "art": {');
    expect(written).toContain('          { "id": "a", "asset": "assets/tiles/cliff_top_a.png" },');
    expect(written).toContain('          "repeat": { "level": 1 }');
    // The tile with no art gains nothing; only the set's own geometry block
    // sits above it, and that is written at a shallower indent.
    const plainTile = written.slice(
      written.indexOf('"id": "plain"'),
      written.indexOf('"id": "cliff"'),
    );
    expect(plainTile).not.toContain('"art"');
    // And it still parses back to what went in.
    expect((JSON.parse(written) as TileSetDefinition).tiles[1]?.art?.elevation?.repeat).toEqual({
      level: 1,
    });
  });
});

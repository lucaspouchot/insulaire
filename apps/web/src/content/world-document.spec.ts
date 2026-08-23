import { describe, expect, it } from 'vitest';

import { offset } from '../core/hex/hex-coords';
import { TileSetDefinition, WorldDefinition } from './content-types';
import { WorldDocument, WorldDocumentError } from './world-document';

const tileSet: TileSetDefinition = {
  id: 'mvp_terrain',
  schemaVersion: 1,
  name: 'Test Terrain',
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
      visual: { visualId: 'terrain.water', fallbackColor: '#20567f' },
    },
  ],
};

const world: WorldDefinition = {
  id: 'tiny',
  schemaVersion: 1,
  name: 'Tiny',
  width: 4,
  height: 3,
  orientation: 'pointy',
  tileSetId: 'mvp_terrain',
  defaultTile: 'grass',
  tiles: [{ at: [1, 1], tile: 'water' }],
  entities: [
    {
      id: 'player_1',
      templateId: 'player',
      at: [0, 0],
      tags: ['hero'],
      properties: { previewCharacter: 'human_player', quest: 'arrival' },
    },
    { id: 'monster_1', templateId: 'monster', at: [3, 2] },
  ],
  locations: [{ id: 'loc_a', at: [2, 0], name: 'Somewhere' }],
  metadata: { author: 'tests' },
};

function documentFor(): WorldDocument {
  return WorldDocument.fromDefinition(world, tileSet);
}

describe('WorldDocument', () => {
  it('expands a sparse definition into a dense grid', () => {
    const document = documentFor();

    expect(document.terrain).toHaveLength(12);
    expect(document.tileAt(offset(1, 1))?.id).toBe('water');
    expect(document.tileAt(offset(0, 0))?.id).toBe('grass');
    expect(document.tileAt(offset(9, 9))).toBeNull();
    expect(document.defaultTile.id).toBe('grass');
  });

  it('carries entities, locations and metadata across', () => {
    const document = documentFor();

    expect(document.placedEntities).toHaveLength(2);
    expect(document.entityAt(offset(0, 0))?.id).toBe('player_1');
    expect(document.entityAt(offset(0, 0))?.tags).toEqual(['hero']);
    expect(document.entityAt(offset(0, 0))?.properties).toEqual({
      previewCharacter: 'human_player',
      quest: 'arrival',
    });
    expect(document.placedLocations[0]?.name).toBe('Somewhere');
    expect(document.metadata['author']).toBe('tests');
  });

  it('round-trips definition -> document -> definition', () => {
    const exported = documentFor().toDefinition(() => new Date('2026-01-01T00:00:00Z'));

    expect(exported.id).toBe(world.id);
    expect(exported.width).toBe(world.width);
    expect(exported.height).toBe(world.height);
    expect(exported.defaultTile).toBe('grass');
    expect(exported.tiles).toEqual(world.tiles);
    expect(exported.entities).toEqual(world.entities);
    expect(exported.locations).toEqual([{ id: 'loc_a', at: [2, 0], name: 'Somewhere' }]);
    expect(exported.metadata?.updatedAt).toBe('2026-01-01T00:00:00.000Z');

    // Re-importing the export must produce an identical grid.
    const reimported = WorldDocument.fromDefinition(exported, tileSet);
    expect(Array.from(reimported.terrain)).toEqual(Array.from(documentFor().terrain));
  });

  it('exports sparsely: only cells differing from the default tile', () => {
    const document = documentFor();
    document.paint(offset(2, 2), 'water');

    const exported = document.toDefinition();
    expect(exported.tiles).toEqual([
      { at: [1, 1], tile: 'water' },
      { at: [2, 2], tile: 'water' },
    ]);

    // Painting a cell back to the default removes it from the file entirely.
    document.paint(offset(1, 1), 'grass');
    expect(document.toDefinition().tiles).toEqual([{ at: [2, 2], tile: 'water' }]);
  });

  it('carries elevation and projection through a round trip', () => {
    const authored: WorldDefinition = {
      ...world,
      projection: 'isometric',
      // Row-major, which is the order the sparse export writes them back in.
      tiles: [
        { at: [2, 0], tile: 'grass', elevation: 5 },
        { at: [1, 1], tile: 'water', elevation: -3 },
      ],
    };

    const document = WorldDocument.fromDefinition(authored, tileSet);
    expect(document.projection).toBe('isometric');
    expect(document.elevationAt(offset(1, 1))).toBe(-3);
    expect(document.elevationAt(offset(2, 0))).toBe(5);
    expect(document.elevationAt(offset(0, 0))).toBe(0);
    expect(document.elevationRange).toEqual({ min: -3, max: 5 });

    // A default-tile cell carrying elevation must still be written out: the
    // sparse export is the only place that elevation can live.
    const exported = document.toDefinition(() => new Date('2026-01-01T00:00:00Z'));
    expect(exported.projection).toBe('isometric');
    expect(exported.tiles).toEqual(authored.tiles);
  });

  it('carries a custom map character scale and omits the default', () => {
    expect(documentFor().characterHeightTiles).toBe(2);
    expect(documentFor().toDefinition()).not.toHaveProperty('characterHeightTiles');

    const document = WorldDocument.fromDefinition(
      { ...world, characterHeightTiles: 3.25 },
      tileSet,
    );
    expect(document.characterHeightTiles).toBe(3.25);
    expect(document.toDefinition().characterHeightTiles).toBe(3.25);
  });

  it('carries authored grid appearance and omits the default', () => {
    expect(documentFor().grid).toEqual({ lineWidth: 1, color: '#000000', alpha: 0.25 });
    expect(documentFor().toDefinition()).not.toHaveProperty('grid');

    const grid = { lineWidth: 3, color: '#336699', alpha: 0.6 };
    const document = WorldDocument.fromDefinition({ ...world, grid }, tileSet);
    expect(document.grid).toEqual(grid);
    expect(document.toDefinition().grid).toEqual(grid);

    expect(document.setGridStyle({ alpha: 0.8 })).toBe(true);
    expect(document.setGridStyle({ alpha: 0.8 })).toBe(false);
    expect(document.toDefinition().grid).toEqual({ ...grid, alpha: 0.8 });
  });

  it('raises and lowers cells within the packed byte range', () => {
    const document = documentFor();

    expect(document.raise(offset(1, 1), 2)).toBe(true);
    expect(document.raise(offset(1, 1), -1)).toBe(true);
    expect(document.elevationAt(offset(1, 1))).toBe(1);

    expect(document.raise(offset(9, 9), 1)).toBe(false);

    document.raise(offset(0, 0), 500);
    expect(document.elevationAt(offset(0, 0))).toBe(127);
    expect(document.raise(offset(0, 0), 3)).toBe(false);

    document.raise(offset(0, 1), -500);
    expect(document.elevationAt(offset(0, 1))).toBe(-128);
  });

  it('defaults an authored world without a projection to top-down', () => {
    expect(documentFor().projection).toBe('topDown');
    expect(documentFor().toDefinition().projection).toBe('topDown');
    expect(documentFor().elevationRange).toEqual({ min: 0, max: 0 });
  });

  /**
   * A zone is authoring organisation, so it has to survive a round trip — and an
   * unzoned map has to export no `zone` at all, or every file predating the
   * field would gain a line the first time the editor re-exports it.
   */
  it('carries a zone through a round trip and omits it when unzoned', () => {
    expect(documentFor().zone).toBe('');
    expect(documentFor().toDefinition()).not.toHaveProperty('zone');

    const zoned = WorldDocument.fromDefinition({ ...world, zone: 'Northern Reach' }, tileSet);
    expect(zoned.zone).toBe('Northern Reach');
    expect(zoned.toDefinition().zone).toBe('Northern Reach');

    zoned.zone = '';
    expect(zoned.toDefinition()).not.toHaveProperty('zone');
  });

  it('reports whether a paint actually changed anything', () => {
    const document = documentFor();
    expect(document.paint(offset(0, 0), 'water')).toBe(true);
    expect(document.paint(offset(0, 0), 'water')).toBe(false);
    expect(document.paint(offset(0, 0), 'lava')).toBe(false);
    expect(document.paint(offset(99, 0), 'water')).toBe(false);
  });

  it('keeps exactly one player and at most one entity per hex', () => {
    const document = documentFor();

    document.placeEntity(offset(2, 1), 'player', true);
    const players = document.placedEntities.filter((entity) => entity.templateId === 'player');
    expect(players).toHaveLength(1);
    expect(players[0]?.at).toEqual(offset(2, 1));

    // Placing on an occupied hex replaces the occupant.
    document.placeEntity(offset(2, 1), 'monster', false);
    expect(document.entityAt(offset(2, 1))?.templateId).toBe('monster');
    expect(document.placedEntities.filter((entity) => entity.templateId === 'player')).toHaveLength(
      0,
    );
  });

  it('generates unique entity ids', () => {
    const document = WorldDocument.create({ id: 'w', name: 'W', width: 5, height: 5, tileSet });
    document.placeEntity(offset(0, 0), 'monster', false);
    document.placeEntity(offset(1, 0), 'monster', false);
    document.placeEntity(offset(2, 0), 'monster', false);

    const ids = document.placedEntities.map((entity) => entity.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['monster_1', 'monster_2', 'monster_3']);
  });

  it('stores an editor preview character without disturbing other properties', () => {
    const document = documentFor();

    expect(document.setEntityPreviewCharacter('player_1', 'forest_hero')).toBe(true);
    expect(document.setEntityPreviewCharacter('player_1', 'forest_hero')).toBe(false);
    expect(document.entityAt(offset(0, 0))?.properties).toEqual({
      previewCharacter: 'forest_hero',
      quest: 'arrival',
    });

    expect(document.setEntityPreviewCharacter('player_1', null)).toBe(true);
    expect(document.entityAt(offset(0, 0))?.properties).toEqual({ quest: 'arrival' });

    const monster = document.placeEntity(offset(2, 1), 'monster', false, 'bog_beast');
    expect(monster?.properties).toEqual({ previewCharacter: 'bog_beast' });
    expect(
      document.toDefinition().entities?.find((entity) => entity.id === monster?.id)?.properties,
    ).toEqual({ previewCharacter: 'bog_beast' });
  });

  it('refuses placements outside the map', () => {
    const document = documentFor();
    expect(document.placeEntity(offset(-1, 0), 'monster', false)).toBeNull();
    expect(document.placeEntity(offset(0, 99), 'monster', false)).toBeNull();
  });

  it('removes entities and locations by cell', () => {
    const document = documentFor();
    expect(document.removeEntityAt(offset(0, 0))).toBe(true);
    expect(document.removeEntityAt(offset(0, 0))).toBe(false);
    expect(document.entityAt(offset(0, 0))).toBeNull();

    expect(document.removeLocationAt(offset(2, 0))).toBe(true);
    expect(document.placedLocations).toHaveLength(0);
  });

  it('creates an empty world filled with the default tile', () => {
    const document = WorldDocument.create({
      id: 'blank',
      name: 'Blank',
      width: 6,
      height: 4,
      tileSet,
      defaultTile: 'water',
    });

    expect(document.terrain).toHaveLength(24);
    expect(document.defaultTile.id).toBe('water');
    expect(document.toDefinition().tiles).toEqual([]);
    expect(document.placedEntities).toEqual([]);
  });

  it('rejects content it cannot represent', () => {
    expect(() =>
      WorldDocument.create({ id: 'x', name: 'X', width: 0, height: 4, tileSet }),
    ).toThrow(WorldDocumentError);

    expect(() =>
      WorldDocument.create({
        id: 'x',
        name: 'X',
        width: 4,
        height: 4,
        tileSet,
        defaultTile: 'lava',
      }),
    ).toThrow(WorldDocumentError);

    expect(() => WorldDocument.fromDefinition({ ...world, tileSetId: 'other' }, tileSet)).toThrow(
      WorldDocumentError,
    );

    expect(() =>
      WorldDocument.fromDefinition({ ...world, tiles: [{ at: [1, 1], tile: 'lava' }] }, tileSet),
    ).toThrow(WorldDocumentError);

    expect(() =>
      WorldDocument.fromDefinition({ ...world, tiles: [{ at: [99, 1], tile: 'water' }] }, tileSet),
    ).toThrow(WorldDocumentError);
  });

  it('counts painted tiles for the status bar', () => {
    const histogram = documentFor().tileHistogram();
    expect(histogram.get('water')).toBe(1);
    expect(histogram.get('grass')).toBe(11);
  });

  describe('cell art', () => {
    it('reads, edits and re-exports what a cell chose', () => {
      const document = WorldDocument.fromDefinition(
        {
          ...world,
          tiles: [{ at: [1, 1], tile: 'water', art: { surface: 'c', elevationTile: 'grass' } }],
        },
        tileSet,
      );

      expect(document.artAt(offset(1, 1))).toEqual({
        surface: 'c',
        elevationTile: 'grass',
        elevation: null,
      });
      // A cell that chose nothing answers with the rolled shape rather than null.
      expect(document.artAt(offset(0, 0))).toEqual({
        surface: null,
        elevationTile: null,
        elevation: null,
      });

      expect(document.setArt(offset(1, 1), { elevation: 'b' })).toBe(true);
      // Setting what is already there changes nothing, so the editor can call
      // it from a change handler without dirtying the project.
      expect(document.setArt(offset(1, 1), { elevation: 'b' })).toBe(false);

      const written = document.toDefinition().tiles?.[0];
      expect(written?.art).toEqual({ surface: 'c', elevationTile: 'grass', elevation: 'b' });
    });

    it('costs nothing on a map where nobody chose', () => {
      const exported = documentFor().toDefinition();
      expect(exported.tiles?.every((tile) => tile.art === undefined)).toBe(true);
      expect(JSON.stringify(exported)).not.toContain('"art"');
    });

    it('writes a default-tile cell that chose, and drops the choice when it is cleared', () => {
      const document = documentFor();
      // [0, 0] is the default tile at elevation zero: its choice is the only
      // reason it has anything to be written down.
      expect(document.setArt(offset(0, 0), { surface: 'f' })).toBe(true);
      expect(document.toDefinition().tiles).toContainEqual({
        at: [0, 0],
        tile: 'grass',
        art: { surface: 'f' },
      });

      expect(document.setArt(offset(0, 0), { surface: null })).toBe(true);
      expect(document.artOverrides.size).toBe(0);
      expect(
        document.toDefinition().tiles?.some((tile) => tile.at[0] === 0 && tile.at[1] === 0),
      ).toBe(false);
    });

    it('drops a choice when the cell is painted with another tile', () => {
      // `grass_f` means nothing on water, and the ids are per tile.
      const document = documentFor();
      document.setArt(offset(0, 0), { surface: 'f', elevationTile: 'water' });

      expect(document.paint(offset(0, 0), 'water')).toBe(true);
      expect(document.artAt(offset(0, 0)).surface).toBeNull();
    });

    it('ignores cells outside the map', () => {
      const document = documentFor();
      expect(document.setArt(offset(-1, 0), { surface: 'a' })).toBe(false);
      expect(document.artAt(offset(99, 99)).surface).toBeNull();
    });
  });

  describe('map links', () => {
    it('places at most one link per cell and exports it', () => {
      const document = documentFor();

      const link = document.placeLink(offset(2, 1), 'inside');
      expect(link?.id).toBe('link_1');
      expect(link?.targetWorld).toBe('inside');
      expect(document.placeLink(offset(2, 1), 'elsewhere')).toBe(link);
      expect(document.placedLinks).toHaveLength(1);
      expect(document.placeLink(offset(99, 9), 'inside')).toBeNull();

      document.updateLink(offset(2, 1), { targetAt: offset(1, 1), name: 'Door' });
      const exported = document.toDefinition().links ?? [];
      expect(exported).toEqual([
        {
          id: 'link_1',
          at: [2, 1],
          targetWorld: 'inside',
          targetAt: [1, 1],
          name: 'Door',
        },
      ]);
    });

    it('round-trips links through a definition', () => {
      const withLink: WorldDefinition = {
        ...world,
        links: [
          { id: 'door', at: [3, 0], targetWorld: 'inside', targetAt: [0, 1], tags: ['door'] },
        ],
      };
      const document = WorldDocument.fromDefinition(withLink, tileSet);

      expect(document.linkAt(offset(3, 0))?.targetWorld).toBe('inside');
      expect(document.linkAt(offset(0, 0))).toBeNull();
      expect(document.toDefinition().links).toEqual(withLink.links);
    });

    it('removes a link and retargets links when a map is renamed', () => {
      const document = documentFor();
      document.placeLink(offset(2, 1), 'inside');

      expect(document.retargetLinks('inside', 'refuge')).toBe(true);
      expect(document.linkAt(offset(2, 1))?.targetWorld).toBe('refuge');
      expect(document.retargetLinks('absent', 'other')).toBe(false);

      expect(document.removeLinkAt(offset(2, 1))).toBe(true);
      expect(document.removeLinkAt(offset(2, 1))).toBe(false);
      expect(document.placedLinks).toHaveLength(0);
    });
  });
});

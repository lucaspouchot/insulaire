import { describe, expect, it } from 'vitest';

import { mapBounds, offset } from '../core/hex/hex-coords';
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

  it('carries an authored reveal and omits the default', () => {
    expect(documentFor().reveal).toEqual({ radius: 1, opacity: 0.25, neighbourOpacity: 0.55 });
    expect(documentFor().toDefinition()).not.toHaveProperty('reveal');

    const reveal = { radius: 3, opacity: 0.1, neighbourOpacity: 0.25 };
    const document = WorldDocument.fromDefinition({ ...world, reveal }, tileSet);
    expect(document.reveal).toEqual(reveal);
    expect(document.toDefinition().reveal).toEqual(reveal);
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

  describe('shape', () => {
    it('starts as a full rectangle and says so by writing no shape', () => {
      const document = documentFor();
      expect(document.presentCellCount).toBe(12);
      expect(document.isPresent(offset(0, 0))).toBe(true);
      expect(document.toDefinition().shape).toBeUndefined();
      expect(document.toDefinition().origin).toBeUndefined();
    });

    it('carves a hex out and puts it back with its paint intact', () => {
      const document = documentFor();
      const water = offset(1, 1);
      expect(document.tileAt(water)?.id).toBe('water');

      expect(document.setPresent(water, false)).toBe(true);
      expect(document.isPresent(water)).toBe(false);
      expect(document.presentCellCount).toBe(11);
      // Paint deliberately outlives the hole
      // (`docs/adr/ADR-0033-a-map-is-a-set-of-hexes.md`).
      expect(document.tileAt(water)?.id).toBe('water');

      expect(document.setPresent(water, true)).toBe(true);
      expect(document.tileAt(water)?.id).toBe('water');
    });

    it('refuses to carve a hex out from under something authored', () => {
      const document = documentFor();
      const player = offset(0, 0);
      expect(document.occupantsAt(player)).toEqual([{ kind: 'entity', id: 'player_1' }]);
      expect(document.setPresent(player, false)).toBe(false);
      expect(document.isPresent(player)).toBe(true);
    });

    it('writes whichever list is shorter', () => {
      const carved = documentFor();
      carved.setPresent(offset(3, 0), false);
      expect(carved.toDefinition().shape).toEqual({ exceptions: [[3, 0]] });

      // Now the other way round: two hexes left out of twelve.
      const drawn = documentFor();
      for (let row = 0; row < 3; row += 1) {
        for (let col = 0; col < 4; col += 1) {
          if (drawn.occupantsAt(offset(col, row)).length === 0) {
            drawn.setPresent(offset(col, row), false);
          }
        }
      }
      const shape = drawn.toDefinition().shape;
      expect(shape?.default).toBe('absent');
      // The three cells that still carry authored content stayed present.
      expect(shape?.exceptions).toEqual([
        [0, 0],
        [2, 0],
        [3, 2],
      ]);
    });

    it('round-trips a shape and an origin through a definition', () => {
      const document = documentFor();
      document.setPresent(offset(2, 1), false);
      document.resize(mapBounds(6, 5, offset(-2, -2)));

      const reloaded = WorldDocument.fromDefinition(document.toDefinition(), tileSet);
      expect(reloaded.bounds).toEqual(mapBounds(6, 5, offset(-2, -2)));
      expect(reloaded.isPresent(offset(2, 1))).toBe(false);
      expect(reloaded.isPresent(offset(0, 0))).toBe(true);
      expect(reloaded.presentCellCount).toBe(document.presentCellCount);
    });

    it('extends northwards by moving the origin, not the cells', () => {
      const document = documentFor();
      const before = document.tileAt(offset(1, 1))?.id;

      expect(document.resize(mapBounds(4, 6, offset(0, -3)))).toBe(true);
      // The authored coordinate still names the hex its author meant, which is
      // what keeps another map's door pointing at it
      // (`docs/adr/ADR-0033-a-map-is-a-set-of-hexes.md`).
      expect(document.tileAt(offset(1, 1))?.id).toBe(before);
      expect(document.isPresent(offset(1, 1))).toBe(true);
      // New canvas arrives empty rather than as a slab of terrain.
      expect(document.isPresent(offset(1, -1))).toBe(false);
      expect(document.presentCellCount).toBe(12);
    });

    it('refuses a trim that would discard hexes the map still has', () => {
      const document = documentFor();
      expect(document.presentOutside(mapBounds(4, 2))).toBe(4);
      expect(document.resize(mapBounds(4, 2))).toBe(false);
      expect(document.bounds).toEqual(mapBounds(4, 3));

      // Carve the row away first, and the same trim goes through — except that
      // the monster is standing on it.
      for (const col of [0, 1, 2]) {
        expect(document.setPresent(offset(col, 2), false)).toBe(true);
      }
      expect(document.occupantsOutside(mapBounds(4, 2))).toEqual([
        { kind: 'entity', id: 'monster_1' },
      ]);
      expect(document.resize(mapBounds(4, 2))).toBe(false);

      document.removeEntityAt(offset(3, 2));
      expect(document.setPresent(offset(3, 2), false)).toBe(true);
      expect(document.resize(mapBounds(4, 2))).toBe(true);
      expect(document.presentCellCount).toBe(8);
    });

    it('counts only the hexes the map has in its histogram', () => {
      const document = documentFor();
      expect(document.tileHistogram().get('water')).toBe(1);
      document.setPresent(offset(1, 1), false);
      expect(document.tileHistogram().get('water')).toBeUndefined();
    });
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

  describe('placed decorations', () => {
    /**
     * The one thing a decoration does that an entity and a door do not: share
     * a cell (`docs/adr/ADR-0035-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
     */
    it('stacks several on one hex and exports them in author order', () => {
      const document = documentFor();
      const at = offset(2, 1);

      const bush = document.placeDecoration(at, 'bush');
      const oak = document.placeDecoration(at, 'oak');
      expect(bush?.id).toBe('bush_1');
      expect(oak?.id).toBe('oak_1');
      expect(document.decorationsAt(at)).toHaveLength(2);
      expect(document.placeDecoration(offset(99, 9), 'oak')).toBeNull();

      // Whether is per placement, and it is off until an author says otherwise.
      expect(oak?.interactive).toBe(false);
      expect(document.updateDecoration('oak_1', { interactive: true })).toBe(true);

      // A nudge, so two bushes on one hex are not one bush drawn twice.
      expect(bush?.offset).toEqual([0, 0]);
      expect(document.updateDecoration('bush_1', { offset: [-6, 2] })).toBe(true);

      expect(document.toDefinition().decorations).toEqual([
        { id: 'bush_1', decoration: 'bush', at: [2, 1], offset: [-6, 2] },
        { id: 'oak_1', decoration: 'oak', at: [2, 1], interactive: true },
      ]);
    });

    it('round-trips placements through a definition', () => {
      const dressed: WorldDefinition = {
        ...world,
        decorations: [
          {
            id: 'oak_0',
            decoration: 'oak',
            at: [3, 0],
            offset: [4, -3],
            interactive: true,
            tags: ['searchable'],
          },
        ],
      };
      const document = WorldDocument.fromDefinition(dressed, tileSet);

      expect(document.decorationsAt(offset(3, 0))[0]?.interactive).toBe(true);
      expect(document.decorationsAt(offset(3, 0))[0]?.offset).toEqual([4, -3]);
      expect(document.decorationsAt(offset(0, 0))).toHaveLength(0);
      expect(document.toDefinition().decorations).toEqual(dressed.decorations);
    });

    /**
     * The id is what a scenario names, so an author writes it — and two
     * placements may never answer to one name.
     */
    it('renames a placement, and refuses a name already taken', () => {
      const document = documentFor();
      const at = offset(2, 1);
      document.placeDecoration(at, 'chest');
      document.placeDecoration(at, 'chest');

      expect(document.renameDecoration('chest_1', 'chest_with_the_letter')).toBe(true);
      expect(document.decorationsAt(at).map((placed) => placed.id)).toEqual([
        'chest_with_the_letter',
        'chest_2',
      ]);

      expect(document.renameDecoration('chest_2', 'chest_with_the_letter')).toBe(false);
      expect(document.renameDecoration('chest_2', '  ')).toBe(false);
      expect(document.renameDecoration('nobody', 'anything')).toBe(false);
      expect(document.decorationsAt(at)[1]?.id).toBe('chest_2');
    });

    /** The eraser takes the one on top, not the whole hex. */
    it('removes the last one placed, one click at a time', () => {
      const document = documentFor();
      const at = offset(2, 1);
      document.placeDecoration(at, 'bush');
      document.placeDecoration(at, 'oak');

      expect(document.removeTopDecorationAt(at)).toBe(true);
      expect(document.decorationsAt(at).map((placed) => placed.decoration)).toEqual(['bush']);
      expect(document.removeTopDecorationAt(at)).toBe(true);
      expect(document.removeTopDecorationAt(at)).toBe(false);
    });

    /** Authored content is never destroyed by a brush stroke (ADR-0033). */
    it('refuses to carve a hex out from under one', () => {
      const document = documentFor();
      const at = offset(2, 1);
      document.placeDecoration(at, 'oak');

      expect(document.occupantsAt(at)).toEqual([{ kind: 'decoration', id: 'oak_1' }]);
      expect(document.setPresent(at, false)).toBe(false);

      expect(document.removeDecoration('oak_1')).toBe(true);
      expect(document.setPresent(at, false)).toBe(true);
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

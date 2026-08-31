/**
 * What {@link TileSetLibrary} promises: replacing a set does not lose a map.
 *
 * A {@link WorldDocument} resolves its palette once, when it is built, so a
 * tile added or renamed in the asset editor is invisible to the map editor
 * until the documents are rebuilt. Rebuilding keeps every painted cell, because
 * a cell holds a palette *index* and the definition it exports holds the tile
 * *id* — which is exactly the indirection ADR-0006 exists for
 * (`docs/adr/ADR-0006-assets-tilesets.md`).
 *
 * The two failure modes worth pinning are the ones that look like success: a
 * map silently emptied by a tile that went away, and a rebuild that makes every
 * map owe the disk a write when nothing an author typed has changed.
 */
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { PROJECT, TILE_SET, world } from './project-fixture';
import { ProjectManifest } from './project-manifest';
import { TileSetLibrary } from './tile-set-library';
import { WorldLibrary } from './world-library';
import { TileSetDefinition } from '../../content/content-types';
import { WorldDocument } from '../../content/world-document';

interface Held {
  readonly tileSets: TileSetLibrary;
  readonly worlds: WorldLibrary;
}

function open(): Held {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({});
  TestBed.inject(ProjectManifest).adopt(PROJECT);
  const tileSets = TestBed.inject(TileSetLibrary);
  const worlds = TestBed.inject(WorldLibrary);
  tileSets.adopt(new Map([['terrain', TILE_SET]]));
  worlds.adopt(
    [world('valley'), world('ridge')].map((definition) =>
      WorldDocument.fromDefinition(definition, TILE_SET),
    ),
    'valley',
    'shipped',
  );
  return { tileSets, worlds };
}

describe('TileSetLibrary — the sets the maps paint with', () => {
  let held: Held;

  beforeEach(() => {
    held = open();
  });

  it('throws for a set the project does not have, rather than answering nothing', () => {
    expect(() => held.tileSets.requireTileSetFor('cave')).toThrow(/not part of this project/);
    expect(held.tileSets.requireTileSet().id).toBe('terrain');
    expect(held.tileSets.tileSetDefinitions().map((set) => set.id)).toEqual(['terrain']);
  });

  it('answers a path from the manifest, or by convention', () => {
    expect(held.tileSets.tileSetPath('terrain')).toBe('tilesets/terrain.json');
    expect(held.tileSets.tileSetPath('cave')).toBe('tilesets/cave.json');
  });

  it('keeps every painted cell when a set is replaced', () => {
    held.worlds.requireDocument().paint({ col: 1, row: 1 }, 'water');
    const before = held.worlds.currentDefinition();

    const renamed = structuredClone(TILE_SET);
    renamed.tiles[1].name = 'Deep water';
    held.tileSets.replaceTileSet(renamed);

    // A cell holds a palette index; the definition holds the id, so the id is
    // what survives the rebuild.
    expect(held.worlds.currentDefinition().tiles).toEqual(before.tiles);
    expect(held.tileSets.requireTileSet().tiles[1].name).toBe('Deep water');
  });

  it('does not count a rebuild as an edit', () => {
    // Replacing a set changes what is *drawn*, not what the author wrote.
    const before = held.worlds.edits();
    held.tileSets.replaceTileSet(structuredClone(TILE_SET));

    expect(held.worlds.edits()).toBe(before);
  });

  it('keeps the open map open across a rebuild', () => {
    held.worlds.selectWorld('ridge');
    held.tileSets.replaceTileSet(structuredClone(TILE_SET));

    expect(held.worlds.activeWorldId()).toBe('ridge');
    expect(held.worlds.documents().map((document) => document.id)).toEqual(['valley', 'ridge']);
  });

  it('leaves a map whose tile was deleted as it was, rather than dropping it', () => {
    // Validation reports `tile.unknownReference`, which is where that belongs;
    // the map editor still shows the map so the author can fix it.
    held.worlds.requireDocument().paint({ col: 1, row: 1 }, 'water');
    const gutted: TileSetDefinition = { ...TILE_SET, tiles: [] };

    held.tileSets.replaceTileSet(gutted);

    expect(held.worlds.documents()).toHaveLength(2);
    expect(held.worlds.requireDocument().palette.length).toBeGreaterThan(0);
  });

  it('leaves a map painting with another set alone', () => {
    const other = { ...structuredClone(TILE_SET), id: 'cave' };
    held.tileSets.adopt(
      new Map([
        ['terrain', TILE_SET],
        ['cave', other],
      ]),
    );
    const untouched = held.worlds.documents()[1];

    held.tileSets.replaceTileSet({ ...other, name: 'Caves' });

    // Identity, not equality: a map that paints with another set is not rebuilt.
    expect(held.worlds.documents()[1]).toBe(untouched);
  });
});

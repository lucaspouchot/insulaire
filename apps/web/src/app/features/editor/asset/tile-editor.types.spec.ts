import { describe, expect, it } from 'vitest';

import { TileDefinition } from '../../../../content/content-types';
import { ASSET_CATEGORIES, assetCategory } from './asset-categories';
import {
  SURFACE_LEVEL,
  artOf,
  blankTile,
  duplicateTile,
  imagePath,
  isUsableId,
  matching,
  pruneArt,
  repeatModeOf,
  sameTarget,
  variantAt,
  variantLetter,
  variantsOf,
} from './tile-editor.types';

/**
 * The asset editor's decisions, tested without Angular.
 *
 * The components own signals and a canvas; everything that can be wrong about
 * *what they do* — which categories exist, the id a tile proposes, the art it
 * writes, the rule it records — lives in the two modules this exercises, which
 * is the same split `character-editor.types.ts` uses
 * (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`).
 */
describe('asset categories', () => {
  it('opens tiles and characters, and declares the ones still coming', () => {
    expect(ASSET_CATEGORIES[0]).toMatchObject({ id: 'tiles', status: 'available' });
    // Characters used to be a module of their own; they are a category now
    // (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`).
    expect(assetCategory('characters')).toMatchObject({ status: 'available' });
    // Declared rather than hidden: the rail is the map of what the tool will be.
    expect(ASSET_CATEGORIES.filter((entry) => entry.status === 'planned').length).toBeGreaterThan(
      0,
    );
  });

  it('gives every category a label and a summary to route with', () => {
    for (const entry of ASSET_CATEGORIES) {
      expect(entry.titleKey.startsWith('ui.editor.asset.categories.')).toBe(true);
      expect(entry.summaryKey.startsWith('ui.editor.asset.categories.')).toBe(true);
    }
  });

  it('answers nothing for a category nobody registered', () => {
    expect(assetCategory('sounds')).toBeUndefined();
  });
});

describe('tile workspace', () => {
  function tile(): TileDefinition {
    return blankTile('grass', 'Grass');
  }

  it('creates a tile that draws a colour until it is given art', () => {
    const created = tile();

    expect(created).toMatchObject({ id: 'grass', name: 'Grass', movementCost: 1 });
    expect(created.visual.visualId).toBe('terrain.grass');
    expect(created.art).toBeUndefined();
  });

  it('refuses an id a content file could not carry', () => {
    expect(isUsableId('mossy_rock')).toBe(true);
    expect(isUsableId('rock-2')).toBe(true);
    expect(isUsableId('Rock')).toBe(false);
    expect(isUsableId('_rock')).toBe(false);
    expect(isUsableId('')).toBe(false);
  });

  it('duplicates a tile with its art and a fresh id', () => {
    const original = tile();
    artOf(original).surface.push({ id: 'a', asset: 'assets/tiles/grass_surface_a.png' });

    const copy = duplicateTile(original, 'grass_2', 'Grass copy');

    expect(copy.id).toBe('grass_2');
    expect(copy.visual.visualId).toBe('terrain.grass_2');
    expect(copy.art?.surface?.[0]?.asset).toBe('assets/tiles/grass_surface_a.png');
    // A deep copy: editing one must not edit the other.
    copy.art?.surface?.push({ id: 'b', asset: 'b.png' });
    expect(original.art?.surface).toHaveLength(1);
  });

  it('files an image under its tile, then its surfaces or its level', () => {
    expect(imagePath('dirt', SURFACE_LEVEL, 'a')).toBe('assets/tiles/dirt/surfaces/dirt_a.png');
    expect(imagePath('dirt', 2, 'b')).toBe('assets/tiles/dirt/elevation/level_2/dirt_b.png');
  });

  it('proposes variant ids that keep going past z', () => {
    expect([0, 1, 25, 26, 27].map(variantLetter)).toEqual(['a', 'b', 'z', 'aa', 'ab']);
  });

  it('fills art in on demand and takes it back out when it empties', () => {
    const current = tile();

    const art = artOf(current);
    art.surface.push({ id: 'a', asset: 'a.png' });
    art.elevation.levels.push({ variants: [{ id: 'a', asset: 'cliff.png' }] });
    expect(variantsOf(current, SURFACE_LEVEL)).toHaveLength(1);
    expect(variantsOf(current, 1)).toHaveLength(1);

    art.surface.length = 0;
    art.elevation.levels.length = 0;
    pruneArt(current);

    // Back to a tile that simply has no art, so the file gains no empty object.
    expect(current.art).toBeUndefined();
  });

  it('reads back the mode of a repeat rule', () => {
    expect(repeatModeOf(undefined)).toBe('last');
    expect(repeatModeOf(null)).toBe('last');
    expect(repeatModeOf({ level: 2 })).toBe('level');
    expect(repeatModeOf({ pattern: [1, 2] })).toBe('pattern');
  });

  it('points at one image at a time', () => {
    const current = tile();
    artOf(current).surface.push({ id: 'a', asset: 'a.png' }, { id: 'b', asset: 'b.png' });

    expect(variantAt(current, { level: SURFACE_LEVEL, variant: 1 })?.asset).toBe('b.png');
    expect(variantAt(current, { level: SURFACE_LEVEL, variant: 9 })).toBeNull();
    expect(variantAt(current, null)).toBeNull();

    const target = { level: SURFACE_LEVEL, variant: 1 };
    expect(sameTarget(target, { level: SURFACE_LEVEL, variant: 1 })).toBe(true);
    expect(sameTarget(target, { level: 1, variant: 1 })).toBe(false);
    expect(sameTarget(target, null)).toBe(false);
  });

  it('searches ids, names, terrain and tags', () => {
    const set = {
      id: 'demo',
      schemaVersion: 2,
      tiles: [
        blankTile('grass', 'Grass'),
        { ...blankTile('stone', 'Rocky Ground'), tags: ['difficult'] },
      ],
    };

    expect(matching(set, '').map((entry) => entry.id)).toEqual(['grass', 'stone']);
    expect(matching(set, 'rocky').map((entry) => entry.id)).toEqual(['stone']);
    expect(matching(set, 'difficult').map((entry) => entry.id)).toEqual(['stone']);
    expect(matching(set, 'nothing')).toEqual([]);
    expect(matching(null, 'grass')).toEqual([]);
  });
});

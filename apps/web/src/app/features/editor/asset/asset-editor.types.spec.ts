import { describe, expect, it } from 'vitest';

import { TileDefinition } from '../../../../content/content-types';
import {
  ASSET_CATEGORIES,
  SURFACE_LEVEL,
  artOf,
  blankTile,
  duplicateTile,
  freeId,
  imagePath,
  isUsableId,
  matching,
  pruneArt,
  repeatModeOf,
  sameTarget,
  variantAt,
  variantLetter,
  variantsOf,
} from './asset-editor.types';

/**
 * The asset editor's decisions, tested without Angular.
 *
 * The component owns signals and a canvas; everything that can be wrong about
 * *what it does* — the id it proposes, the art it writes, the rule it records —
 * lives in the module this exercises, which is the same split the character
 * editor uses.
 */
describe('asset editor', () => {
  function tile(): TileDefinition {
    return blankTile('grass', 'Grass');
  }

  it('offers tiles first and declares the categories that are still coming', () => {
    expect(ASSET_CATEGORIES[0]).toMatchObject({ id: 'tiles', status: 'available' });
    // Declared rather than hidden: the browser is the map of what the tool will be.
    expect(ASSET_CATEGORIES.filter((entry) => entry.status === 'planned').length).toBeGreaterThan(0);
  });

  it('creates a tile that draws a colour until it is given art', () => {
    const created = tile();

    expect(created).toMatchObject({ id: 'grass', name: 'Grass', movementCost: 1 });
    expect(created.visual.visualId).toBe('terrain.grass');
    expect(created.art).toBeUndefined();
  });

  it('proposes an id nothing else has taken', () => {
    expect(freeId('Mossy Rock', [])).toBe('mossy_rock');
    expect(freeId('grass', ['grass'])).toBe('grass_2');
    expect(freeId('grass', ['grass', 'grass_2'])).toBe('grass_3');
    expect(freeId('!!!', [])).toBe('tile');
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

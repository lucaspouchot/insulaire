import { describe, expect, it } from 'vitest';

import {
  ElevationLevel,
  ElevationRepeat,
  TileArt,
  TileArtVariant,
} from '../content/content-types';
import {
  MAX_STACKED_LEVELS,
  projectionRatiosOf,
  resolveTileRender,
  sourceLevel,
  variantIndex,
  variantRoll,
} from './tile-art';

/**
 * The mirror of `crates/world/src/tile_art.rs`'s own tests.
 *
 * Case for case, so the two implementations cannot drift: a change on one side
 * that is not made on the other fails here or there
 * (`docs/adr/ADR-0014-hex-coordinate-model.md` set that precedent for the hex
 * maths; `docs/adr/ADR-0035-tile-art-is-authored-and-resolved-by-level.md`
 * extends it to resolution). `engine-integration.spec.ts` closes the loop by
 * asking the real WASM build for the same answers.
 */
describe('tile art resolution', () => {
  function variant(id: string): TileArtVariant {
    return { id, asset: `assets/tiles/${id}.png` };
  }

  function level(id: string): ElevationLevel {
    return { variants: [variant(id)] };
  }

  function art(levels: ElevationLevel[], repeat?: ElevationRepeat): TileArt {
    return { surface: [variant('grass_01')], elevation: { levels, repeat } };
  }

  it('draws a flat cell from its surface and nothing else', () => {
    const resolved = resolveTileRender('grass', art([level('cliff_01')]), 0, 0, 0);

    expect(resolved.surface).toBe('assets/tiles/grass_01.png');
    expect(resolved.layers).toEqual([]);
  });

  it('resolves a tile with no art to nothing', () => {
    const resolved = resolveTileRender('grass', {}, 3, 0, 0);

    expect(resolved.surface).toBeNull();
    expect(resolved.layers).toEqual([]);
  });

  it('stacks explicit levels bottom to top', () => {
    const resolved = resolveTileRender(
      'mountain',
      art([level('a'), level('b'), level('c')]),
      3,
      0,
      0,
    );

    expect(resolved.layers.map((layer) => [layer.level, layer.drop, layer.asset])).toEqual([
      [1, 2, 'assets/tiles/a.png'],
      [2, 1, 'assets/tiles/b.png'],
      [3, 0, 'assets/tiles/c.png'],
    ]);
    // An elevation image is the faces alone, so the top face is still the
    // tile's own surface — a raised cell keeps its surface variants.
    expect(resolved.surface).toBe('assets/tiles/grass_01.png');
  });

  it('repeats the last explicit level by default', () => {
    const elevation = art([level('a'), level('b')]).elevation;

    expect(sourceLevel(elevation, 1)).toBe(1);
    expect(sourceLevel(elevation, 2)).toBe(2);
    expect(sourceLevel(elevation, 3)).toBe(2);
    expect(sourceLevel(elevation, 50)).toBe(2);
  });

  it('reuses the level a repeat rule names', () => {
    const tile = art([level('a'), level('b')], { level: 1 });

    expect(sourceLevel(tile.elevation, 3)).toBe(1);
    expect(sourceLevel(tile.elevation, 10)).toBe(1);
    expect(
      resolveTileRender('mountain', tile, 4, 0, 0).layers.map((layer) => layer.sourceLevel),
    ).toEqual([1, 2, 1, 1]);
  });

  it('moves a repeated asset down whole steps without transforming it', () => {
    const resolved = resolveTileRender('mountain', art([level('a')], { level: 1 }), 3, 0, 0);

    expect(resolved.layers.every((layer) => layer.asset === 'assets/tiles/a.png')).toBe(true);
    expect(resolved.layers.map((layer) => layer.drop)).toEqual([2, 1, 0]);
  });

  it('cycles a pattern through the levels it names', () => {
    const tile = art([level('a'), level('b'), level('c')], { pattern: [2, 3] });

    expect([1, 2, 3, 4, 5, 6, 7].map((l) => sourceLevel(tile.elevation, l))).toEqual([
      1, 2, 3, 2, 3, 2, 3,
    ]);
  });

  it('falls back to the last level when a pattern names nothing usable', () => {
    expect(sourceLevel(art([level('a')], { pattern: [9] }).elevation, 4)).toBe(1);
  });

  it('costs no extra art for a tall cell', () => {
    const resolved = resolveTileRender(
      'mountain',
      art([level('a'), level('b')], { level: 2 }),
      100,
      0,
      0,
    );

    expect(resolved.layers).toHaveLength(MAX_STACKED_LEVELS);
    expect(
      resolved.layers.every(
        (layer) => layer.asset === 'assets/tiles/b.png' && layer.sourceLevel === 2,
      ),
    ).toBe(true);
    expect(resolved.layers.at(-1)?.level).toBe(100);
  });

  it('keeps its own surface at every height', () => {
    const tile = art([level('a'), level('b')], { level: 2 });

    for (const elevation of [0, 1, 2, 3, 12]) {
      const resolved = resolveTileRender('mountain', tile, elevation, 0, 0);
      expect(resolved.surface, `elevation ${elevation}`).toBe('assets/tiles/grass_01.png');
      expect(resolved.layers.some((layer) => layer.asset === 'assets/tiles/grass_01.png')).toBe(
        false,
      );
    }
  });

  it('draws only the visible drop', () => {
    // Standing at 5 next to neighbours at 4: one step of face shows.
    const resolved = resolveTileRender('mountain', art([level('a')]), 5, 4, 0);

    expect(resolved.layers).toHaveLength(1);
    expect(resolved.layers[0]?.level).toBe(5);
    expect(resolved.layers[0]?.drop).toBe(0);
  });

  it('still draws the faces of a cell dug below its neighbours', () => {
    const resolved = resolveTileRender('rock', art([level('a')]), -1, -3, 0);

    expect(resolved.layers).toHaveLength(2);
    expect(resolved.layers.every((layer) => layer.sourceLevel === 1)).toBe(true);
  });

  it('rolls a variant deterministically, and differently per cell', () => {
    const salt = 'grass';

    expect(variantRoll(3, 4, salt)).toBe(variantRoll(3, 4, salt));
    expect(variantRoll(3, 4, salt)).not.toBe(variantRoll(4, 3, salt));
    expect(variantRoll(3, 4, salt)).not.toBe(variantRoll(3, 4, 'sand'));
    // Negative coordinates hash the same two's-complement bytes Rust hashes.
    expect(variantRoll(-1, -1, salt)).toBe(variantRoll(-1, -1, salt));

    expect(variantIndex(7, 4)).toBe(3);
    expect(variantIndex(7, 0)).toBeNull();
  });

  it('varies the variant down a column', () => {
    const tile: TileArt = {
      elevation: { levels: [{ variants: [variant('a'), variant('b')] }] },
    };

    expect(resolveTileRender('rock', tile, 4, 0, 0).layers.map((layer) => layer.asset)).toEqual([
      'assets/tiles/b.png',
      'assets/tiles/a.png',
      'assets/tiles/b.png',
      'assets/tiles/a.png',
    ]);
  });

  it('derives the projection from the authored pixel grid', () => {
    const { tilt, elevationRatio } = projectionRatiosOf({
      width: 32,
      surfaceHeight: 20,
      elevationHeight: 28,
      elevationStep: 8,
    });

    // A surface image is the top face's bounding box: sqrt(3) * size wide and
    // 2 * size * tilt tall, so the tilt is fixed by the image's aspect ratio.
    expect(tilt).toBeCloseTo((20 / 32) * (Math.sqrt(3) / 2), 10);
    // One step of relief is 8 of the image's 32 pixels, measured in hex widths.
    expect(elevationRatio).toBeCloseTo((8 / 32) * Math.sqrt(3), 10);
  });
});

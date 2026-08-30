import { describe, expect, it } from 'vitest';

import {
  ElevationLevel,
  ElevationRepeat,
  TileArt,
  TileArtVariant,
} from '../content/content-types';
import {
  MAX_STACKED_LEVELS,
  isEmptyRender,
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
 * (`docs/adr/ADR-0011-hex-coordinate-model.md` set that precedent for the hex
 * maths; `docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`
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

  it('draws a level cell from its surface and nothing else', () => {
    const resolved = resolveTileRender('grass', art([level('cliff_01')]), 'isometric', 0, 0, 0);

    expect(resolved.surface).toBe('assets/tiles/grass_01.png');
    expect(resolved.layers).toEqual([]);
  });

  it('resolves a tile with no art to nothing', () => {
    const resolved = resolveTileRender('grass', {}, 'isometric', 3, 0, 0);

    expect(resolved.surface).toBeNull();
    expect(resolved.layers).toEqual([]);
  });

  it('stacks explicit levels bottom to top', () => {
    const tile = art([level('a'), level('b'), level('c')]);
    const resolved = resolveTileRender('mountain', tile, 'isometric', 3, 0, 0);

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
    const resolved = resolveTileRender('mountain', tile, 'isometric', 4, 0, 0);
    expect(resolved.layers.map((layer) => layer.sourceLevel)).toEqual([1, 2, 1, 1]);
  });

  it('moves a repeated asset down whole steps without transforming it', () => {
    const tile = art([level('a')], { level: 1 });
    const resolved = resolveTileRender('mountain', tile, 'isometric', 3, 0, 0);

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
    const tile = art([level('a'), level('b')], { level: 2 });
    const resolved = resolveTileRender('mountain', tile, 'isometric', 100, 0, 0);

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
      const resolved = resolveTileRender('mountain', tile, 'isometric', elevation, 0, 0);
      expect(resolved.surface, `elevation ${elevation}`).toBe('assets/tiles/grass_01.png');
      expect(resolved.layers.some((layer) => layer.asset === 'assets/tiles/grass_01.png')).toBe(
        false,
      );
    }
  });

  it('draws only the visible drop', () => {
    // Standing at 5 next to neighbours at 4: one step of face shows.
    const resolved = resolveTileRender('mountain', art([level('a')]), 'isometric', 5, 4, 0);

    expect(resolved.layers).toHaveLength(1);
    expect(resolved.layers[0]?.level).toBe(5);
    expect(resolved.layers[0]?.drop).toBe(0);
  });

  it('still draws the faces of a cell dug below its neighbours', () => {
    const resolved = resolveTileRender('rock', art([level('a')]), 'isometric', -1, -3, 0);

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

  it('keeps one face the whole way down a column', () => {
    // A cliff is one cut through one ground, so its layers agree: the variety
    // is between cells and between levels, not down a single column
    // (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`).
    const tile: TileArt = {
      surface: [variant('top_a'), variant('top_b')],
      elevation: { levels: [{ variants: [variant('a'), variant('b')] }] },
    };

    const resolved = resolveTileRender('rock', tile, 'isometric', 4, 0, 1);
    expect(resolved.layers.map((layer) => layer.asset)).toEqual(
      Array<string>(4).fill('assets/tiles/b.png'),
    );
  });

  it('draws a top-down cell from its flat image and no relief', () => {
    // The two projections are two sets of pictures, and a top-down world never
    // reaches for the isometric ones
    // (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`).
    const tile: TileArt = {
      flat: [variant('flat_a'), variant('flat_b')],
      surface: [variant('top_a'), variant('top_b')],
      elevation: { levels: [{ variants: [variant('a')] }] },
    };

    const resolved = resolveTileRender('rock', tile, 'topDown', 4, 0, 1);
    expect(resolved.flat).toBe('assets/tiles/flat_b.png');
    expect(resolved.surface).toBeNull();
    expect(resolved.layers).toEqual([]);
    expect(isEmptyRender(resolved)).toBe(false);

    // The same roll, drawn isometrically: the other set of images entirely.
    const tilted = resolveTileRender('rock', tile, 'isometric', 4, 0, 1);
    expect(tilted.flat).toBeNull();
    expect(tilted.surface).toBe('assets/tiles/top_b.png');
    expect(tilted.layers).toHaveLength(4);
  });

  it('resolves a tile with no flat image to nothing, top-down', () => {
    // Which is what tells the renderer to fill `fallbackColor`, rather than
    // stretching a surface into a shape it was not drawn for.
    const tile: TileArt = { surface: [variant('top_a')] };

    expect(isEmptyRender(resolveTileRender('rock', tile, 'topDown', 0, 0, 0))).toBe(true);
  });

  it('picks the same letter in either projection', () => {
    // One index serves both lists, so a cell that chose `b` shows `b` whichever
    // way the map is drawn — and wraps rather than losing its picture when the
    // two lists are different lengths.
    const tile: TileArt = {
      flat: [variant('flat_a'), variant('flat_b')],
      surface: [variant('top_a'), variant('top_b'), variant('top_c')],
    };

    expect(resolveTileRender('rock', tile, 'topDown', 0, 0, 0, { surface: 1 }).flat).toBe(
      'assets/tiles/flat_b.png',
    );
    expect(resolveTileRender('rock', tile, 'isometric', 0, 0, 0, { surface: 1 }).surface).toBe(
      'assets/tiles/top_b.png',
    );
    // Index 2 exists among the surfaces and not among the flats.
    expect(resolveTileRender('rock', tile, 'topDown', 0, 0, 0, { surface: 2 }).flat).toBe(
      'assets/tiles/flat_a.png',
    );
  });

  it('cuts a face out of the variant its surface took', () => {
    const tile: TileArt = {
      surface: [variant('top_a'), variant('top_b')],
      elevation: { levels: [{ variants: [variant('a'), variant('b')] }] },
    };

    for (const [roll, top, face] of [
      [0, 'top_a', 'a'],
      [1, 'top_b', 'b'],
    ] as const) {
      const resolved = resolveTileRender('rock', tile, 'isometric', 3, 0, roll);
      expect(resolved.surface).toBe(`assets/tiles/${top}.png`);
      expect(resolved.layers.every((layer) => layer.asset === `assets/tiles/${face}.png`)).toBe(
        true,
      );
    }
  });

  it('lets a cell name its own surface and face', () => {
    const tile: TileArt = {
      surface: [variant('top_a'), variant('top_b')],
      elevation: { levels: [{ variants: [variant('a'), variant('b')] }] },
    };

    const resolved = resolveTileRender('rock', tile, 'isometric', 2, 0, 0, {
      surface: 1,
      elevationVariant: 0,
    });

    expect(resolved.surface).toBe('assets/tiles/top_b.png');
    expect(resolved.layers.every((layer) => layer.asset === 'assets/tiles/a.png')).toBe(true);
  });

  it('cuts a cell out of another tile\'s ladder, keeping its own top face', () => {
    // The point of the feature: grass on top, rock underneath.
    const meadow: TileArt = { surface: [variant('turf')] };
    const cliff: TileArt = { elevation: { levels: [{ variants: [variant('granite')] }] } };

    const resolved = resolveTileRender('grass', meadow, 'isometric', 2, 0, 0, { elevation: cliff });

    expect(resolved.surface).toBe('assets/tiles/turf.png');
    expect(resolved.layers).toHaveLength(2);
    expect(resolved.layers.every((layer) => layer.asset === 'assets/tiles/granite.png')).toBe(
      true,
    );
  });

  it('wraps a chosen variant rather than dropping the layer', () => {
    const tile: TileArt = {
      surface: [variant('a'), variant('b'), variant('c')],
      elevation: { levels: [{ variants: [variant('face_a'), variant('face_b')] }] },
    };

    const resolved = resolveTileRender('rock', tile, 'isometric', 1, 0, 0, { surface: 2 });

    expect(resolved.surface).toBe('assets/tiles/c.png');
    expect(resolved.layers.map((layer) => layer.asset)).toEqual(['assets/tiles/face_a.png']);
  });

  it('derives the projection from the authored pixel grid', () => {
    const { tilt, elevationRatio } = projectionRatiosOf({
      width: 32,
      flatHeight: 37,
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

import { describe, expect, it } from 'vitest';

import { TileArt, faceHeight, shoulderDepth, shoulderLine } from '../content/content-types';
import { offset } from '../core/hex/hex-coords';
import { SpriteSource } from './character-renderer';
import { RenderModel, emptyRenderModel } from './render-model';
import { Composition, CompositionFactory, TileAppearanceCache } from './tile-appearance';

/**
 * The flyweight's two promises: cells that look alike share one object, and
 * what that object holds is the same picture the renderer used to build per
 * cell, per frame (`docs/adr/ADR-0038-a-map-is-drawn-from-shared-pictures.md`).
 *
 * Sharing is the half that is easy to get wrong quietly — a key that forgets a
 * field shows the wrong picture, one that includes too much shares nothing —
 * so most of what is below counts objects rather than inspecting them.
 */
describe('TileAppearanceCache', () => {
  const GEOMETRY = emptyRenderModel().tileArt;

  /** A source where every asset is loaded unless it is named as missing. */
  function imagesOf(missing: readonly string[] = []): SpriteSource {
    return {
      image: (asset) =>
        missing.includes(asset) ? null : ({ asset } as unknown as CanvasImageSource),
      preload: () => Promise.resolve(),
    };
  }

  /** A composition factory that records what was stacked into what. */
  function recorder(): {
    factory: CompositionFactory;
    made: { width: number; height: number; blits: { asset: string; y: number }[] }[];
  } {
    const made: { width: number; height: number; blits: { asset: string; y: number }[] }[] = [];
    const factory: CompositionFactory = (width, height) => {
      const blits: { asset: string; y: number }[] = [];
      made.push({ width, height, blits });
      const composition: Composition = {
        target: { composed: made.length } as unknown as CanvasImageSource,
        context: {
          imageSmoothingEnabled: true,
          drawImage: (image, _x, y) => {
            blits.push({ asset: (image as unknown as { asset: string }).asset, y });
          },
        },
      };
      return composition;
    };
    return { factory, made };
  }

  function modelWith(
    art: TileArt,
    projection: 'topDown' | 'isometric' = 'isometric',
    tileArt = GEOMETRY,
  ): RenderModel {
    return {
      ...emptyRenderModel(),
      width: 16,
      height: 16,
      projection,
      tileArt,
      palette: [
        {
          index: 0,
          id: 'dirt',
          name: 'Dirt',
          terrain: 'dirt',
          movementCost: 1,
          passable: true,
          visualId: 'terrain.dirt',
          fallbackColor: '#7a5230',
          tags: [],
          art,
        },
      ],
      terrain: new Uint8Array(16 * 16),
      elevation: new Int8Array(16 * 16),
    };
  }

  const ONE_VARIANT: TileArt = {
    surface: [{ id: 'a', asset: 'top_a.png' }],
    flat: [{ id: 'a', asset: 'flat_a.png' }],
    elevation: { levels: [{ variants: [{ id: 'a', asset: 'face_a.png' }] }] },
  };

  const TWO_VARIANTS: TileArt = {
    surface: [
      { id: 'a', asset: 'top_a.png' },
      { id: 'b', asset: 'top_b.png' },
    ],
  };

  function cacheOf(
    model: RenderModel,
    images: SpriteSource = imagesOf(),
    factory?: CompositionFactory,
  ): TileAppearanceCache {
    const cache = new TileAppearanceCache(images, factory ?? (() => null));
    cache.use(model);
    return cache;
  }

  it('hands two cells that look alike the very same picture', () => {
    const cache = cacheOf(modelWith(ONE_VARIANT));

    const here = cache.of(0, 0, offset(0, 0), 0, 0);
    const far = cache.of(0, 5 * 16 + 9, offset(9, 5), 0, 0);

    expect(here).not.toBeNull();
    // The same object, not an equal one: that is what "shared" means, and it is
    // the allocation this cache exists to remove.
    expect(far).toBe(here);
    expect(cache.size).toBe(1);
  });

  it('costs one picture per variant, however many cells roll it', () => {
    const cache = cacheOf(modelWith(TWO_VARIANTS));

    const looks = new Set<unknown>();
    for (let row = 0; row < 16; row += 1) {
      for (let col = 0; col < 16; col += 1) {
        looks.add(cache.of(0, row * 16 + col, offset(col, row), 0, 0));
      }
    }

    // 256 cells, two authored variants, two pictures — and both are rolled, so
    // the map is varied without being expensive.
    expect(looks.size).toBe(2);
    expect(cache.size).toBe(2);
  });

  it('keeps heights and drops apart', () => {
    const cache = cacheOf(modelWith(ONE_VARIANT));

    const flat = cache.of(0, 0, offset(0, 0), 0, 0);
    const raised = cache.of(0, 1, offset(1, 0), 2, 0);
    const perched = cache.of(0, 2, offset(2, 0), 2, 1);

    expect(raised).not.toBe(flat);
    expect(perched).not.toBe(raised);
    // A cell two steps above what it fronts shows two steps of face; one above,
    // one — the drop is what is drawn, not the height.
    expect(raised?.render.layers).toHaveLength(2);
    expect(perched?.render.layers).toHaveLength(1);
  });

  it('waits for what the map is painted with, not for the whole palette', () => {
    const base = modelWith(ONE_VARIANT);
    const model: RenderModel = {
      ...base,
      palette: [
        ...base.palette,
        {
          ...(base.palette[0] as (typeof base.palette)[number]),
          index: 1,
          id: 'rock',
          art: {
            surface: [{ id: 'a', asset: 'rock_top.png' }],
            elevation: { levels: [{ variants: [{ id: 'a', asset: 'rock_face.png' }] }] },
          },
        },
      ],
    };
    const cache = cacheOf(model);

    // Nothing is painted with `rock`, so nothing waits for it…
    expect(cache.paintedAssets().sort()).toEqual(['face_a.png', 'top_a.png']);
    // …but it is still a brush, and the editor fetches it afterwards.
    expect(cache.assets()).toContain('rock_top.png');
  });

  it('counts a borrowed cliff as painted, though no cell wears the tile', () => {
    const base = modelWith(ONE_VARIANT);
    const model: RenderModel = {
      ...base,
      palette: [
        ...base.palette,
        {
          ...(base.palette[0] as (typeof base.palette)[number]),
          index: 1,
          id: 'rock',
          art: { elevation: { levels: [{ variants: [{ id: 'a', asset: 'rock_face.png' }] }] } },
        },
      ],
      // Grass on top, rock underneath
      // (`docs/adr/ADR-0036-a-cell-may-choose-its-tile-art.md`).
      artChoices: new Map([[0, { surface: null, elevationTile: 1, elevation: null }]]),
    };

    expect(cacheOf(model).paintedAssets()).toContain('rock_face.png');
  });

  it('asks for the art of the projection in force, and no other', () => {
    expect(cacheOf(modelWith(ONE_VARIANT, 'isometric')).assets().sort()).toEqual([
      'face_a.png',
      'top_a.png',
    ]);
    // A top-down world draws no relief at all, so it fetches none
    // (`docs/adr/ADR-0037-a-flat-map-is-drawn-from-flat-art.md`).
    expect(cacheOf(modelWith(ONE_VARIANT, 'topDown')).assets()).toEqual(['flat_a.png']);
  });

  it('stacks a cell into one picture, faces first and the top face last', () => {
    const { factory, made } = recorder();
    const cache = cacheOf(modelWith(ONE_VARIANT), imagesOf(), factory);

    const raised = cache.of(0, 0, offset(0, 0), 2, 0);

    expect(raised?.ready).toBe(true);
    expect(raised?.picture).not.toBeNull();
    expect(made).toHaveLength(1);

    const composed = made[0];
    expect(composed?.width).toBe(GEOMETRY.width);
    // Two steps of face below the shoulder line, and the image's own height
    // under the lowest of them.
    expect(composed?.height).toBe(
      shoulderLine(GEOMETRY) + GEOMETRY.elevationStep + GEOMETRY.elevationHeight,
    );
    expect(raised?.pictureHeight).toBe(composed?.height);
    expect(composed?.blits.map((blit) => blit.asset)).toEqual([
      'face_a.png',
      'face_a.png',
      'top_a.png',
    ]);
    // Lowest face first, one authored step apart, and the top face at the very
    // top of the picture — the order and the offsets `drawPaintedCell` used to
    // apply one blit at a time.
    expect(composed?.blits.map((blit) => blit.y)).toEqual([
      shoulderLine(GEOMETRY) + GEOMETRY.elevationStep,
      shoulderLine(GEOMETRY),
      0,
    ]);
  });

  it('draws one band per two levels when a level lifts half a band', () => {
    // The shipped shape: the art keeps its whole band and a level lifts half of
    // it, so three levels of relief are one image and half of the next — not
    // three slices of the same picture, which is what reads as stripes.
    const overlapping = { ...GEOMETRY, elevationStep: faceHeight(GEOMETRY) / 2 };
    const { factory, made } = recorder();
    const cache = cacheOf(modelWith(ONE_VARIANT, 'isometric', overlapping), imagesOf(), factory);

    const raised = cache.of(0, 0, offset(0, 0), 3, 0);

    // Two images for three steps, and they walk the ladder one level per band.
    expect(raised?.render.layers.map((layer) => layer.level)).toEqual([1, 2]);
    const composed = made[0];
    expect(composed?.blits.map((blit) => blit.y)).toEqual([
      shoulderLine(overlapping) + overlapping.elevationStep,
      shoulderLine(overlapping) - overlapping.elevationStep,
      0,
    ]);
    // The one thing that has to hold: the lowest band ends exactly where the
    // hexagon's silhouette does, three steps below the shoulders — which is
    // where `addWallTo` puts the foot of the colour wall behind the art
    // (`docs/adr/ADR-0035-tile-art-is-authored-and-resolved-by-level.md`).
    const foot =
      shoulderLine(overlapping) + 3 * overlapping.elevationStep + shoulderDepth(overlapping);
    expect((composed?.blits[0]?.y ?? 0) + overlapping.elevationHeight).toBe(foot);
    expect(composed?.height).toBe(foot);
    // The topmost band starts above the top face, which is drawn last over it.
    expect(composed?.blits[1]?.y).toBeLessThan(shoulderLine(overlapping));
    expect(raised?.pictureTop).toBe(0);
  });

  it('shows one whole band the step a cell is tall enough for it', () => {
    const overlapping = { ...GEOMETRY, elevationStep: faceHeight(GEOMETRY) / 2 };
    const { factory, made } = recorder();
    const cache = cacheOf(modelWith(ONE_VARIANT, 'isometric', overlapping), imagesOf(), factory);

    const raised = cache.of(0, 0, offset(0, 0), 2, 0);

    // Two steps *are* one band, so the image sits exactly on the shoulder line
    // and every row of it is exposed.
    expect(raised?.render.layers).toHaveLength(1);
    expect(made[0]?.blits.map((blit) => blit.y)).toEqual([shoulderLine(overlapping), 0]);
  });

  it('composes a cell once, however many cells wear it', () => {
    const { factory, made } = recorder();
    const cache = cacheOf(modelWith(ONE_VARIANT), imagesOf(), factory);

    for (let col = 0; col < 8; col += 1) {
      cache.of(0, col, offset(col, 0), 1, 0);
    }

    expect(made).toHaveLength(1);
  });

  it('waits for every image a look needs before it composes anything', () => {
    const { factory, made } = recorder();
    const missing = ['face_a.png'];
    const images: SpriteSource = {
      image: (asset) =>
        missing.includes(asset) ? null : ({ asset } as unknown as CanvasImageSource),
      preload: () => Promise.resolve(),
    };
    const cache = cacheOf(modelWith(ONE_VARIANT), images, factory);

    const waiting = cache.of(0, 0, offset(0, 0), 1, 0);
    // Not ready is the colour path: half a cliff is worse than a coloured one
    // (`docs/adr/ADR-0009-assets-tilesets.md`).
    expect(waiting?.ready).toBe(false);
    expect(waiting?.picture).toBeNull();
    expect(made).toHaveLength(0);

    missing.length = 0;
    const arrived = cache.of(0, 0, offset(0, 0), 1, 0);
    // The same object the first frame was handed: it is the picture that
    // arrived, not the cell that changed.
    expect(arrived).toBe(waiting);
    expect(arrived?.ready).toBe(true);
    expect(made).toHaveLength(1);
  });

  it('draws nothing for a tile whose art says nothing about this projection', () => {
    const surfacesOnly: TileArt = { surface: [{ id: 'a', asset: 'top_a.png' }] };
    const cache = cacheOf(modelWith(surfacesOnly, 'topDown'));

    expect(cache.of(0, 0, offset(0, 0), 0, 0)).toBeNull();
  });

  it('forgets its pictures when the palette or the projection changes', () => {
    const cache = cacheOf(modelWith(ONE_VARIANT));
    cache.of(0, 0, offset(0, 0), 0, 0);
    expect(cache.size).toBe(1);

    // A new palette is new art: nothing cached against the old one may survive.
    cache.use(modelWith(TWO_VARIANTS));
    expect(cache.size).toBe(0);
  });

  it('honours what a cell chose by hand', () => {
    const model: RenderModel = {
      ...modelWith(TWO_VARIANTS),
      artChoices: new Map([[0, { surface: 1, elevationTile: null, elevation: null }]]),
    };
    const cache = cacheOf(model);

    const chosen = cache.of(0, 0, offset(0, 0), 0, 0);
    expect(chosen?.render.surface).toBe('top_b.png');

    // Every other cell rolls, and the ones that roll the *other* variant are a
    // different look — a choice is a look of its own, and a cell that happens
    // to roll what was chosen shares it, which is the point
    // (`docs/adr/ADR-0036-a-cell-may-choose-its-tile-art.md`).
    const rolled = [...Array(16).keys()]
      .map((col) => cache.of(0, col + 1, offset(col + 1, 0), 0, 0))
      .filter((look) => look?.render.surface === 'top_a.png');
    expect(rolled.length).toBeGreaterThan(0);
    for (const look of rolled) {
      expect(look).not.toBe(chosen);
    }
  });
});

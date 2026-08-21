import { beforeAll, describe, expect, it, vi } from 'vitest';

import { TileArt, shoulderDepth, shoulderLine } from '../content/content-types';
import { offset } from '../core/hex/hex-coords';
import { HexLayout } from '../core/hex/hex-layout';
import { Camera } from './camera';
import { SpriteSource } from './character-renderer';
import { HexMapRenderer } from './hex-map-renderer';
import { Projection } from './projection';
import { RenderModel, emptyRenderModel } from './render-model';
import { projectionRatiosOf } from './tile-art';

/**
 * The projection the renderer will use for a default model.
 *
 * Derived exactly as `HexMapRenderer` derives it, from the tile set's authored
 * pixel grid rather than from a pair of constants: a test that wrote the tilt
 * down would pass against a picture the renderer no longer draws
 * (`docs/adr/ADR-0035-tile-art-is-authored-and-resolved-by-level.md`).
 */
function isometricFor(hexSize: number): Projection {
  const { tilt, elevationRatio } = projectionRatiosOf(emptyRenderModel().tileArt);
  return Projection.from('isometric', hexSize, tilt, elevationRatio);
}

/**
 * Hit-testing only, which is the half of the renderer that has to be exactly
 * right: whatever the projection does, clicking a hex must select *that* hex,
 * and clicking where two cells overlap must select the one the viewer sees.
 *
 * Drawing itself needs a real canvas and is not covered here; the context is a
 * stub, and nothing these tests touch draws anything.
 */
describe('HexMapRenderer hit-testing', () => {
  const HEX_SIZE = 24;
  const LAYOUT = new HexLayout(HEX_SIZE);
  const ISOMETRIC = isometricFor(HEX_SIZE);
  const RAISED = offset(4, 6);

  /** How far back the hill has to reach for the occlusion test to mean anything. */
  const ROWS_BEHIND = 2;

  /**
   * The hill's height, derived rather than written down: it is whatever lifts
   * the top face onto the centre of the cell {@link ROWS_BEHIND} rows behind it.
   *
   * A literal would quietly stop occluding anything the day the elevation step
   * is retuned, and the overlap test below would then pass by asserting on a
   * picture the renderer no longer draws.
   */
  const ELEVATION = Math.round(
    (ROWS_BEHIND * LAYOUT.rowStep * ISOMETRIC.tilt) / ISOMETRIC.elevationStep,
  );

  function model(projection: 'topDown' | 'isometric', raised = false): RenderModel {
    const width = 10;
    const height = 10;
    const elevation = new Int8Array(width * height);
    if (raised) {
      elevation[RAISED.row * width + RAISED.col] = ELEVATION;
    }
    return {
      ...emptyRenderModel(),
      width,
      height,
      projection,
      terrain: new Uint8Array(width * height),
      elevation,
      elevationRange: { min: 0, max: raised ? ELEVATION : 0 },
    };
  }

  function rendererFor(source: RenderModel): HexMapRenderer {
    const renderer = new HexMapRenderer({} as CanvasRenderingContext2D, LAYOUT, new Camera());
    renderer.setModel(source);
    return renderer;
  }

  it('resolves every cell to itself in top-down mode', () => {
    const flat = model('topDown');
    const renderer = rendererFor(flat);
    for (let row = 0; row < flat.height; row += 1) {
      for (let col = 0; col < flat.width; col += 1) {
        const cell = offset(col, row);
        expect(renderer.cellAtScreen(renderer.layout.centerOf(cell))).toEqual(cell);
      }
    }
  });

  it('resolves every cell to itself in isometric mode', () => {
    const flat = model('isometric');
    const renderer = rendererFor(flat);

    for (let row = 0; row < flat.height; row += 1) {
      for (let col = 0; col < flat.width; col += 1) {
        const cell = offset(col, row);
        const screen = ISOMETRIC.project(renderer.layout.centerOf(cell));
        expect(renderer.cellAtScreen(screen)).toEqual(cell);
      }
    }
  });

  it('picks an elevated cell by its top face and by its side face', () => {
    const relief = model('isometric', true);
    const renderer = rendererFor(relief);
    const center = renderer.layout.centerOf(RAISED);

    expect(renderer.cellAtScreen(ISOMETRIC.project(center, ELEVATION))).toEqual(RAISED);

    // Halfway down the cliff face: below the top face, above the cell's own row.
    const lift = ISOMETRIC.liftOf(ELEVATION);
    const bottom = ISOMETRIC.project({ x: center.x, y: center.y + HEX_SIZE }, ELEVATION);
    expect(renderer.cellAtScreen({ x: bottom.x, y: bottom.y + lift / 2 })).toEqual(RAISED);
  });

  it('gives the cell in front when an elevated tile covers the one behind', () => {
    const relief = model('isometric', true);
    const renderer = rendererFor(relief);

    // Column-aligned and rows back, so this point is the *centre* of a perfectly
    // ordinary cell — and yet the raised tile is drawn over it.
    const behind = offset(RAISED.col, RAISED.row - ROWS_BEHIND);
    const screen = ISOMETRIC.project(renderer.layout.centerOf(behind));

    expect(renderer.cellAtScreen(screen)).toEqual(RAISED);
    // The same world without the hill resolves it the obvious way.
    expect(rendererFor(model('isometric')).cellAtScreen(screen)).toEqual(behind);
  });

  /**
   * A cell dug *below* its neighbours exposes their side faces just as a raised
   * cell exposes its own — the drop is the same drop, seen from the other end.
   * The renderer used to anchor every side face at elevation `0`, so nothing was
   * drawn here and the background showed through the gap.
   */
  it('picks the cell above a dug neighbour by the side face the drop exposes', () => {
    const width = 10;
    const height = 10;
    const above = offset(4, 5);
    const depth = 3;
    const elevation = new Int8Array(width * height);
    // The cell the *front-right* edge of `above` faces: odd rows lean right.
    elevation[(above.row + 1) * width + above.col + 1] = -depth;

    const renderer = rendererFor({
      ...emptyRenderModel(),
      width,
      height,
      projection: 'isometric',
      terrain: new Uint8Array(width * height),
      elevation,
      elevationRange: { min: -depth, max: 0 },
    });
    const center = renderer.layout.centerOf(above);

    // Halfway down the exposed face, on the front-right edge — right of the
    // bottom corner, where the cell in front no longer covers anything.
    const edge = ISOMETRIC.project({ x: center.x + HEX_SIZE * 0.4, y: center.y + HEX_SIZE * 0.8 });
    expect(renderer.cellAtScreen({ x: edge.x, y: edge.y + ISOMETRIC.liftOf(depth) / 2 })).toEqual(
      above,
    );
  });

  it('returns null outside the map', () => {
    const renderer = rendererFor(model('isometric', true));
    expect(renderer.cellAtScreen({ x: -500, y: -500 })).toBeNull();
    expect(renderer.cellAtScreen({ x: 5_000, y: 5_000 })).toBeNull();
  });
});

/**
 * What the camera frames. A bound that is merely *safe* is not good enough
 * here: empty space inside the rectangle is empty space on screen, and the map
 * then sits off-centre by however much the bound overshoots.
 */
describe('HexMapRenderer content bounds', () => {
  const HEX_SIZE = 24;
  const RAISED = offset(4, 6);
  const ELEVATION = 4;

  function rendererFor(source: RenderModel): HexMapRenderer {
    const renderer = new HexMapRenderer(
      {} as CanvasRenderingContext2D,
      new HexLayout(HEX_SIZE),
      new Camera(),
    );
    renderer.setModel(source);
    return renderer;
  }

  function model(projection: 'topDown' | 'isometric', raised = false): RenderModel {
    const width = 10;
    const height = 10;
    const elevation = new Int8Array(width * height);
    if (raised) {
      elevation[RAISED.row * width + RAISED.col] = ELEVATION;
    }
    return {
      ...emptyRenderModel(),
      width,
      height,
      projection,
      terrain: new Uint8Array(width * height),
      elevation,
      elevationRange: { min: 0, max: raised ? ELEVATION : 0 },
    };
  }

  it('is the plain hex plane in top-down mode', () => {
    const flat = model('topDown');
    expect(rendererFor(flat).contentBounds()).toEqual(
      new HexLayout(HEX_SIZE).boundsOf(flat.width, flat.height),
    );
  });

  it('is the flattened plane when an isometric map has no relief', () => {
    const flat = model('isometric');
    const plane = new HexLayout(HEX_SIZE).boundsOf(flat.width, flat.height);
    const projection = isometricFor(HEX_SIZE);

    expect(rendererFor(flat).contentBounds()).toEqual(projection.projectRect(plane));
  });

  /**
   * The regression: lifting the whole plane by the map's peak left a band of
   * empty sky above rows that are flat, and `fit` framed it.
   */
  it('lifts only the row the peak stands on', () => {
    const relief = model('isometric', true);
    const layout = new HexLayout(HEX_SIZE);
    const projection = isometricFor(HEX_SIZE);
    const plane = layout.boundsOf(relief.width, relief.height);
    const bounds = rendererFor(relief).contentBounds();

    // Row 6 carries the hill, and even lifted it does not reach above row 0.
    const peakTop = layout.rowStep * RAISED.row * projection.tilt - projection.liftOf(ELEVATION);
    expect(peakTop).toBeGreaterThan(plane.minY * projection.tilt);
    expect(bounds.minY).toBeCloseTo(plane.minY * projection.tilt);
    // Lifting the whole plane, as this used to, frames that much empty sky.
    expect(bounds.minY - projection.projectRect(plane, 0, ELEVATION).minY).toBeCloseTo(
      projection.liftOf(ELEVATION),
    );
  });

  /** The front row keeps its skirt: side faces there drop to ground level. */
  it('keeps the bottom edge the front skirt reaches', () => {
    const relief = model('isometric', true);
    const layout = new HexLayout(HEX_SIZE);
    const projection = isometricFor(HEX_SIZE);
    const bounds = rendererFor(relief).contentBounds();

    const plane = layout.boundsOf(relief.width, relief.height);
    expect(bounds.maxY).toBeCloseTo(plane.maxY * projection.tilt);
  });

  it('drops as far as the deepest cell is dug', () => {
    const width = 10;
    const height = 10;
    const depth = 3;
    const elevation = new Int8Array(width * height);
    elevation[(height - 1) * width + 5] = -depth;
    const projection = isometricFor(HEX_SIZE);
    const layout = new HexLayout(HEX_SIZE);

    const bounds = rendererFor({
      ...emptyRenderModel(),
      width,
      height,
      projection: 'isometric',
      terrain: new Uint8Array(width * height),
      elevation,
      elevationRange: { min: -depth, max: 0 },
    }).contentBounds();

    expect(bounds.maxY).toBeCloseTo(
      layout.boundsOf(width, height).maxY * projection.tilt + projection.liftOf(depth),
    );
  });
});

/**
 * Where a cell's art actually lands on the canvas.
 *
 * The blit is the one thing about tile art a picture-free test can still pin
 * exactly: an elevation image is the faces alone, so its `V` has to fall on the
 * hexagon's own lower edges. Half a hex out and the faces hide behind the top
 * face, leaving the drop empty — which is the bug this covers
 * (`docs/adr/ADR-0035-tile-art-is-authored-and-resolved-by-level.md`).
 */
describe('HexMapRenderer tile art', () => {
  const HEX_SIZE = 24;
  const LAYOUT = new HexLayout(HEX_SIZE);
  const RAISED = offset(1, 0);

  /** What `drawImage` was asked to paint, in drawing-plane coordinates. */
  interface Blit {
    asset: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }

  /**
   * A canvas that records instead of painting.
   *
   * A proxy rather than a hand-written double: the renderer touches a couple of
   * dozen context members and none of them but these two say anything about
   * where the art went.
   */
  function recorder(): {
    context: CanvasRenderingContext2D;
    blits: Blit[];
    fills: number;
  } {
    const blits: Blit[] = [];
    const state = { fills: 0 };
    const context = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === 'drawImage') {
            return (image: { asset: string }, x: number, y: number, width: number, height: number) =>
              blits.push({ asset: image.asset, x, y, width, height });
          }
          if (property === 'fill') {
            return () => {
              state.fills += 1;
            };
          }
          if (property === 'measureText') {
            return () => ({ width: 0 });
          }
          return () => undefined;
        },
        set: () => true,
      },
    ) as CanvasRenderingContext2D;
    return {
      context,
      blits,
      get fills() {
        return state.fills;
      },
    };
  }

  /**
   * jsdom ships no canvas, so the class the batches accumulate into is missing.
   * Nothing here inspects a path — only how many were filled — so a shell of one
   * is enough.
   */
  beforeAll(() => {
    globalThis.Path2D ??= class {
      moveTo(): void {}
      lineTo(): void {}
      closePath(): void {}
    } as unknown as typeof Path2D;
  });

  /** Every asset resolves, so nothing falls back for want of a download. */
  const IMAGES: SpriteSource = {
    image: (asset: string) => ({ asset }) as unknown as CanvasImageSource,
    preload: () => Promise.resolve(),
  };

  function modelWith(art: TileArt): RenderModel {
    const width = 3;
    const height = 3;
    const elevation = new Int8Array(width * height);
    elevation[RAISED.row * width + RAISED.col] = 1;
    const base = emptyRenderModel();
    return {
      ...base,
      width,
      height,
      projection: 'isometric',
      showGrid: false,
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
      terrain: new Uint8Array(width * height),
      elevation,
      elevationRange: { min: 0, max: 1 },
    };
  }

  function drawnBy(art: TileArt): { blits: Blit[]; fills: number } {
    const canvas = recorder();
    const renderer = new HexMapRenderer(canvas.context, LAYOUT, new Camera(), undefined, IMAGES);
    renderer.setModel(modelWith(art));
    renderer.draw(600, 600);
    return { blits: canvas.blits, fills: canvas.fills };
  }

  const FULL: TileArt = {
    surface: [{ id: 'a', asset: 'top.png' }],
    elevation: { levels: [{ variants: [{ id: 'a', asset: 'face.png' }] }] },
  };

  it('hangs an elevation image off the hexagon it belongs to', () => {
    const geometry = emptyRenderModel().tileArt;
    const projection = isometricFor(HEX_SIZE);
    const { blits } = drawnBy(FULL);

    const face = blits.find((blit) => blit.asset === 'face.png');
    expect(face).toBeDefined();

    const perPixel = LAYOUT.hexWidth / geometry.width;
    const corners = LAYOUT.corners(LAYOUT.centerOf(RAISED)).map((corner) =>
      projection.project(corner, 1),
    );
    const south = corners[2];
    expect(south).toBeDefined();

    // The image's own `V` is its top `shoulderDepth` rows, and it has to sit
    // exactly on the two lower edges: its point *is* the hexagon's south vertex.
    expect((face?.y ?? 0) + shoulderDepth(geometry) * perPixel).toBeCloseTo(south?.y ?? 0, 6);
    // What hangs below that point is one authored step of relief.
    expect((face?.y ?? 0) + (face?.height ?? 0)).toBeCloseTo(
      (south?.y ?? 0) + projection.elevationStep,
      6,
    );
    expect(face?.width).toBeCloseTo(LAYOUT.hexWidth, 6);
  });

  it('draws the top face over the faces, at every height', () => {
    const { blits } = drawnBy(FULL);

    // Faces first, then the tile's own surface over them: a face image never
    // owns a top face, so the raised cell blits both, in that order.
    const face = blits.findIndex((blit) => blit.asset === 'face.png');
    expect(face).toBeGreaterThanOrEqual(0);
    expect(blits[face + 1]?.asset).toBe('top.png');
    expect(blits[face + 1]?.x).toBeCloseTo(blits[face]?.x ?? 0, 6);
  });

  it('fills the drop in colour when the tile authors a top face and no cliff', () => {
    const bare: TileArt = { surface: [{ id: 'a', asset: 'top.png' }] };
    const { blits, fills } = drawnBy(bare);

    // The top face is still authored art…
    expect(new Set(blits.map((blit) => blit.asset))).toEqual(new Set(['top.png']));
    // …and the faces it does not author are the fallback colour, not a hole.
    expect(fills).toBeGreaterThan(0);
  });

  it('leaves no colour behind a cliff that is fully authored', () => {
    expect(drawnBy(FULL).fills).toBe(0);
  });

  /**
   * The same map, on a platform that can compose.
   *
   * The tests above run where `OffscreenCanvas` does not exist, which is the
   * layer-by-layer fallback; this one gives the renderer somewhere to stack a
   * cell once and checks that the cell is then *one* blit
   * (`docs/adr/ADR-0038-a-map-is-drawn-from-shared-pictures.md`).
   */
  function withComposition<T>(body: () => T): T {
    class Composed {
      /** Named like a loaded image, so the recorder reports it the same way. */
      readonly asset = 'composed';
      constructor(
        readonly width: number,
        readonly height: number,
      ) {}
      getContext(): unknown {
        return { imageSmoothingEnabled: false, drawImage: () => undefined };
      }
    }
    const previous = globalThis.OffscreenCanvas;
    globalThis.OffscreenCanvas = Composed as unknown as typeof OffscreenCanvas;
    try {
      return body();
    } finally {
      globalThis.OffscreenCanvas = previous;
    }
  }

  it('draws a stacked cell as a single composed picture', () => {
    const geometry = emptyRenderModel().tileArt;
    const projection = isometricFor(HEX_SIZE);
    const { blits } = withComposition(() => drawnBy(FULL));

    // Nine cells, nine blits: the raised one stacked its face and its top face
    // into one picture instead of blitting both.
    expect(blits).toHaveLength(9);
    const stacked = blits.filter((blit) => blit.asset === 'composed');
    expect(stacked).toHaveLength(1);

    const perPixel = LAYOUT.hexWidth / geometry.width;
    const centre = projection.project(LAYOUT.centerOf(RAISED), 1);
    const picture = stacked[0];
    expect(picture?.x).toBeCloseTo(centre.x - LAYOUT.hexWidth / 2, 6);
    // It hangs from the top face's own top edge, exactly where the surface
    // image alone used to be blitted…
    expect(picture?.y).toBeCloseTo(centre.y - (LAYOUT.hexHeight * projection.tilt) / 2, 6);
    expect(picture?.width).toBeCloseTo(LAYOUT.hexWidth, 6);
    // …and reaches one authored step of face below the shoulder line.
    expect(picture?.height).toBeCloseTo(
      (shoulderLine(geometry) + geometry.elevationHeight) * perPixel,
      6,
    );
  });

  it('counts the pictures its cells share', () => {
    const canvas = recorder();
    const renderer = new HexMapRenderer(canvas.context, LAYOUT, new Camera(), undefined, IMAGES);
    renderer.setModel(modelWith(FULL));
    renderer.draw(600, 600);

    // Nine cells, two looks: flat ground, and the one cell standing above it.
    expect(renderer.frameStats.cellsDrawn).toBe(9);
    expect(renderer.frameStats.tilePictures).toBe(2);
  });

  it('paints nothing at all while the art it needs is still on the wire', async () => {
    let arrive = (): void => undefined;
    const slow: SpriteSource = {
      image: (asset: string) => ({ asset }) as unknown as CanvasImageSource,
      preload: () => new Promise<void>((resolve) => (arrive = resolve)),
    };
    const canvas = recorder();
    const renderer = new HexMapRenderer(canvas.context, LAYOUT, new Camera(), undefined, slow);
    renderer.setModel(modelWith(FULL));

    const warmed = renderer.warmTileArt();
    renderer.draw(600, 600);
    // Not one tile, not one colour: a map half made of pictures and half of
    // placeholders is what this whole change exists to stop showing
    // (`docs/adr/ADR-0038-a-map-is-drawn-from-shared-pictures.md`).
    expect(canvas.blits).toHaveLength(0);
    expect(canvas.fills).toBe(0);
    expect(renderer.frameStats.cellsDrawn).toBe(0);

    arrive();
    await warmed;

    renderer.draw(600, 600);
    expect(canvas.blits.length).toBeGreaterThan(0);
  });

  it('asks for the bundle before it asks for a single file', async () => {
    const asked: string[] = [];
    let landed = (): void => undefined;
    const source: SpriteSource = {
      image: (asset: string) => ({ asset }) as unknown as CanvasImageSource,
      preload: (assets: Iterable<string>) => {
        asked.push(`preload:${[...assets].length}`);
        return Promise.resolve();
      },
      loadBundle: (url: string) => {
        asked.push(`bundle:${url}`);
        return new Promise<void>((resolve) => (landed = resolve));
      },
    };
    const canvas = recorder();
    const renderer = new HexMapRenderer(
      canvas.context,
      LAYOUT,
      new Camera(),
      undefined,
      source,
      '/content/tile-art.bundle',
    );
    renderer.setModel(modelWith(FULL));

    const warmed = renderer.warmTileArt();

    // The order is the whole point: a `preload` that ran first would fetch the
    // files the bundle is about to carry
    // (`docs/adr/ADR-0040-tile-art-travels-as-one-bundle.md`).
    expect(asked).toEqual(['bundle:/content/tile-art.bundle']);
    // And nothing is drawn meanwhile, so no frame resolves a cell and asks for
    // its images one at a time.
    renderer.draw(600, 600);
    expect(canvas.blits).toHaveLength(0);
    expect(renderer.isWarming).toBe(true);

    landed();
    await warmed;

    expect(asked[1]).toMatch(/^preload:/);
    expect(renderer.isWarming).toBe(false);
  });

  it('loads the map file by file when the bundle cannot be read', async () => {
    const asked: string[] = [];
    const source: SpriteSource = {
      image: (asset: string) => ({ asset }) as unknown as CanvasImageSource,
      preload: (assets: Iterable<string>) => {
        asked.push(`preload:${[...assets].length}`);
        return Promise.resolve();
      },
      loadBundle: () => Promise.reject(new Error('no bundle at that URL')),
    };
    const canvas = recorder();
    const renderer = new HexMapRenderer(
      canvas.context,
      LAYOUT,
      new Camera(),
      undefined,
      source,
      '/content/tile-art.bundle',
    );
    renderer.setModel(modelWith(FULL));

    await renderer.warmTileArt();

    expect(asked[0]).toMatch(/^preload:/);
    expect(renderer.isWarming).toBe(false);
    renderer.draw(600, 600);
    expect(canvas.blits.length).toBeGreaterThan(0);
  });

  it('never asks for a bundle when it was given no URL', async () => {
    const loadBundle = vi.fn(() => Promise.resolve());
    const source: SpriteSource = {
      image: (asset: string) => ({ asset }) as unknown as CanvasImageSource,
      preload: () => Promise.resolve(),
      loadBundle,
    };
    const canvas = recorder();
    const renderer = new HexMapRenderer(canvas.context, LAYOUT, new Camera(), undefined, source);
    renderer.setModel(modelWith(FULL));

    await renderer.warmTileArt();

    expect(loadBundle).not.toHaveBeenCalled();
  });
});

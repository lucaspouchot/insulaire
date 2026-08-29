import { beforeAll, describe, expect, it, vi } from 'vitest';

import { TileArt, shoulderDepth, shoulderLine } from '../content/content-types';
import { mapBounds, offset } from '../core/hex/hex-coords';
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
      bounds: mapBounds(width, height),
      projection,
      terrain: new Uint8Array(width * height),
      presence: new Uint8Array(width * height).fill(1),
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
    for (let row = 0; row < flat.bounds.height; row += 1) {
      for (let col = 0; col < flat.bounds.width; col += 1) {
        const cell = offset(col, row);
        expect(renderer.cellAtScreen(renderer.layout.centerOf(cell))).toEqual(cell);
      }
    }
  });

  it('resolves every cell to itself in isometric mode', () => {
    const flat = model('isometric');
    const renderer = rendererFor(flat);

    for (let row = 0; row < flat.bounds.height; row += 1) {
      for (let col = 0; col < flat.bounds.width; col += 1) {
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
      bounds: mapBounds(width, height),
      projection: 'isometric',
      terrain: new Uint8Array(width * height),
      presence: new Uint8Array(width * height).fill(1),
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
      bounds: mapBounds(width, height),
      projection,
      terrain: new Uint8Array(width * height),
      presence: new Uint8Array(width * height).fill(1),
      elevation,
      elevationRange: { min: 0, max: raised ? ELEVATION : 0 },
    };
  }

  it('is the plain hex plane in top-down mode', () => {
    const flat = model('topDown');
    expect(rendererFor(flat).contentBounds()).toEqual(
      new HexLayout(HEX_SIZE).boundsOf(flat.bounds),
    );
  });

  it('is the flattened plane when an isometric map has no relief', () => {
    const flat = model('isometric');
    const plane = new HexLayout(HEX_SIZE).boundsOf(flat.bounds);
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
    const plane = layout.boundsOf(relief.bounds);
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

    const plane = layout.boundsOf(relief.bounds);
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
      bounds: mapBounds(width, height),
      projection: 'isometric',
      terrain: new Uint8Array(width * height),
      presence: new Uint8Array(width * height).fill(1),
      elevation,
      elevationRange: { min: -depth, max: 0 },
    }).contentBounds();

    expect(bounds.maxY).toBeCloseTo(
      layout.boundsOf(mapBounds(width, height)).maxY * projection.tilt + projection.liftOf(depth),
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
            return (
              image: { asset: string },
              x: number,
              y: number,
              width: number,
              height: number,
            ) => blits.push({ asset: image.asset, x, y, width, height });
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
      bounds: mapBounds(width, height),
      presence: new Uint8Array(width * height).fill(1),
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

/**
 * The hover outline belongs to the renderer, not to the model.
 *
 * A hex the pointer crosses changes nothing about the world, so it must not
 * cost a model: the host used to rebuild one per hex, which put a rebuild and a
 * change-detection pass between the hand and two strokes of chrome.
 */
describe('HexMapRenderer hover', () => {
  const HEX_SIZE = 24;
  const LAYOUT = new HexLayout(HEX_SIZE);

  beforeAll(() => {
    globalThis.Path2D ??= class {
      moveTo(): void {}
      lineTo(): void {}
      closePath(): void {}
      addPath(): void {}
    } as unknown as typeof Path2D;
  });

  /** Records the colour of every stroke, which is all a highlight is. */
  function strokeRecorder(): { context: CanvasRenderingContext2D; strokes: string[] } {
    const strokes: string[] = [];
    let colour = '';
    const context = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === 'stroke') {
            return () => strokes.push(colour);
          }
          if (property === 'measureText') {
            return () => ({ width: 0 });
          }
          return () => undefined;
        },
        set(_target, property, value) {
          if (property === 'strokeStyle') {
            colour = String(value);
          }
          return true;
        },
      },
    ) as CanvasRenderingContext2D;
    return { context, strokes };
  }

  function flatModel(): RenderModel {
    const width = 4;
    const height = 4;
    return {
      ...emptyRenderModel(),
      bounds: mapBounds(width, height),
      terrain: new Uint8Array(width * height),
      presence: new Uint8Array(width * height).fill(1),
      elevation: new Int8Array(width * height),
      // The grid strokes too, and nothing here is about the grid.
      showGrid: false,
    };
  }

  it('outlines the hovered hex, and nothing when there is none', () => {
    const canvas = strokeRecorder();
    const renderer = new HexMapRenderer(canvas.context, LAYOUT, new Camera());
    renderer.setModel(flatModel());

    renderer.draw(400, 400);
    expect(canvas.strokes).toHaveLength(0);

    renderer.setHover(offset(1, 2));
    renderer.draw(400, 400);
    expect(canvas.strokes).toHaveLength(1);

    renderer.setHover(null);
    renderer.draw(400, 400);
    expect(canvas.strokes).toHaveLength(1);
  });

  it('keeps the hovered hex across a new model', () => {
    const canvas = strokeRecorder();
    const renderer = new HexMapRenderer(canvas.context, LAYOUT, new Camera());
    renderer.setModel(flatModel());
    renderer.setHover(offset(1, 2));

    // The world moved under a pointer that did not: an entity stepped, a tile
    // was painted. The cursor is still over the same hex.
    renderer.setModel(flatModel());
    renderer.draw(400, 400);

    expect(canvas.strokes).toHaveLength(1);
  });

  it('draws the grid with the requested authored appearance', () => {
    const widths: number[] = [];
    let lineWidth = 0;
    let strokeStyle = '';
    let globalAlpha = 1;
    const context = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === 'stroke') {
            return () => {
              widths.push(lineWidth);
              expect(strokeStyle).toBe('#336699');
              expect(globalAlpha).toBe(0.6);
            };
          }
          if (property === 'measureText') {
            return () => ({ width: 0 });
          }
          return () => undefined;
        },
        set(_target, property, value) {
          if (property === 'lineWidth') {
            lineWidth = Number(value);
          } else if (property === 'strokeStyle') {
            strokeStyle = String(value);
          } else if (property === 'globalAlpha') {
            globalAlpha = Number(value);
          }
          return true;
        },
      },
    ) as CanvasRenderingContext2D;
    const renderer = new HexMapRenderer(context, LAYOUT, new Camera());
    renderer.setModel({
      ...flatModel(),
      showGrid: true,
      gridLineWidth: 3,
      gridLineColor: '#336699',
      gridLineAlpha: 0.6,
    });

    renderer.draw(400, 400);

    expect(widths).toEqual([3]);
  });

  it('strokes the extent fainter than the map, and only where it is shown', () => {
    const alphas: number[] = [];
    let globalAlpha = 1;
    const context = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === 'stroke') {
            return () => alphas.push(globalAlpha);
          }
          if (property === 'measureText') {
            return () => ({ width: 0 });
          }
          return () => undefined;
        },
        set(_target, property, value) {
          if (property === 'globalAlpha') {
            globalAlpha = Number(value);
          }
          return true;
        },
      },
    ) as CanvasRenderingContext2D;

    const base = flatModel();
    const shaped = new Uint8Array(base.presence);
    shaped[0] = 0;

    // The editor shows the canvas an author may draw into: two strokes, the
    // ghost first and fainter (`docs/adr/ADR-0046-a-map-is-a-set-of-hexes.md`).
    const editor = new HexMapRenderer(context, LAYOUT, new Camera());
    editor.setModel({ ...base, presence: shaped, showGrid: true, showExtent: true });
    editor.draw(400, 400);
    expect(alphas).toEqual([base.gridLineAlpha * 0.4, base.gridLineAlpha]);

    // Play does not: a hole is simply not part of the world.
    alphas.length = 0;
    const play = new HexMapRenderer(context, LAYOUT, new Camera());
    play.setModel({ ...base, presence: shaped, showGrid: true, showExtent: false });
    play.draw(400, 400);
    expect(alphas).toEqual([base.gridLineAlpha]);
  });

  it('resolves a hole only where the extent is shown', () => {
    const base = flatModel();
    const shaped = new Uint8Array(base.presence);
    shaped[0] = 0;
    const hole = offset(0, 0);

    const editor = new HexMapRenderer({} as CanvasRenderingContext2D, LAYOUT, new Camera());
    editor.setModel({ ...base, presence: shaped, showExtent: true });
    expect(editor.cellAtScreen(LAYOUT.centerOf(hole))).toEqual(hole);

    const play = new HexMapRenderer({} as CanvasRenderingContext2D, LAYOUT, new Camera());
    play.setModel({ ...base, presence: shaped, showExtent: false });
    expect(play.cellAtScreen(LAYOUT.centerOf(hole))).toBeNull();
  });

  it('draws an entity character instead of its fallback glyph', () => {
    const drawn: string[] = [];
    const text: string[] = [];
    const scales: Array<readonly [number, number]> = [];
    const context = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === 'drawImage') {
            return (image: { asset?: string }) => drawn.push(image.asset ?? '?');
          }
          if (property === 'fillText') {
            return (value: string) => text.push(value);
          }
          if (property === 'scale') {
            return (x: number, y: number) => scales.push([x, y]);
          }
          if (property === 'measureText') {
            return () => ({ width: 0 });
          }
          return () => undefined;
        },
        set() {
          return true;
        },
      },
    ) as CanvasRenderingContext2D;
    const source: SpriteSource = {
      image: (asset) => ({ asset }) as unknown as CanvasImageSource,
      preload: () => Promise.resolve(),
    };
    const renderer = new HexMapRenderer(context, LAYOUT, new Camera(), undefined, source);
    renderer.setModel({
      ...flatModel(),
      entities: [
        {
          id: 'p',
          at: offset(1, 1),
          visualId: 'entity.player',
          fallbackColor: '#fff',
          glyph: '@',
          emphasised: true,
        },
      ],
    });
    renderer.setEntityCharacter('p', {
      character: 'hero',
      category: 'player',
      resolution: { width: 32, height: 64 },
      values: {},
      mirrored: false,
      layers: [
        {
          layer: 'body',
          variant: 'default',
          rect: [8, 8, 16, 56],
          origin: [0, 0],
          offset: [0, 0],
          asset: 'hero.png',
          tint: '',
        },
      ],
    });

    renderer.draw(400, 400);

    expect(drawn).toEqual(['hero.png']);
    expect(text).not.toContain('@');
    // The first scale is the camera. A 64px character is half the 128px
    // reference, so at the default ratio it stands one 48px tile high.
    expect(scales).toContainEqual([0.75, 0.75]);
  });

  it('interpolates fallback entities between their authoritative cells', () => {
    const arcs: Array<readonly [number, number]> = [];
    const context = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === 'arc') {
            return (x: number, y: number) => arcs.push([x, y]);
          }
          if (property === 'measureText') {
            return () => ({ width: 0 });
          }
          return () => undefined;
        },
        set: () => true,
      },
    ) as CanvasRenderingContext2D;
    const from = offset(0, 0);
    const to = offset(1, 0);
    const renderer = new HexMapRenderer(context, LAYOUT, new Camera());
    renderer.setModel({
      ...flatModel(),
      entities: [
        {
          id: 'monster',
          at: to,
          motion: { from, progress: 0.5 },
          visualId: 'entity.monster',
          fallbackColor: '#c00',
          glyph: 'M',
          emphasised: false,
        },
      ],
    });

    renderer.draw(400, 400);

    const start = LAYOUT.centerOf(from);
    const end = LAYOUT.centerOf(to);
    expect(arcs).toContainEqual([(start.x + end.x) / 2, (start.y + end.y) / 2]);
  });
});

/**
 * Seeing — and reaching — a hex the relief hides.
 *
 * The projection is not injective: a cell raised enough is drawn where the cell
 * behind it is drawn, so a pixel names two hexes and the picture cannot say
 * which. These pin both halves of the answer: the reveal, which needs no intent
 * because it decides nothing, and the peek, which is the intent that resolves
 * the ambiguity (`docs/adr/ADR-0047-relief-never-hides-a-hex.md`).
 */
describe('HexMapRenderer reveal', () => {
  const HEX_SIZE = 24;
  const LAYOUT = new HexLayout(HEX_SIZE);
  const ISOMETRIC = isometricFor(HEX_SIZE);
  const HILL = offset(4, 6);
  const ROWS_BEHIND = 2;

  /**
   * Whatever lifts the hill's top face onto the centre of the cell
   * {@link ROWS_BEHIND} rows behind it — which, those rows sharing a parity,
   * puts the two hexagons on top of each other.
   */
  const ELEVATION = Math.round(
    (ROWS_BEHIND * LAYOUT.rowStep * ISOMETRIC.tilt) / ISOMETRIC.elevationStep,
  );

  const BURIED = offset(HILL.col, HILL.row - ROWS_BEHIND);

  beforeAll(() => {
    globalThis.Path2D ??= class {
      moveTo(): void {}
      lineTo(): void {}
      closePath(): void {}
      addPath(): void {}
    } as unknown as typeof Path2D;
  });

  /**
   * A world with one raised cell, or — with `ridge` — its two neighbours raised
   * with it.
   *
   * One hill buries the hex behind it and no more: its neighbours in that row
   * are half a hexagon to the side, so half of each is left showing. Burying a
   * ring takes a ridge, which is what a mountain on a real map is.
   */
  function model(
    elevation: number,
    projection: 'topDown' | 'isometric' = 'isometric',
    ridge = false,
  ): RenderModel {
    const width = 10;
    const height = 10;
    const heights = new Int8Array(width * height);
    heights[HILL.row * width + HILL.col] = elevation;
    if (ridge) {
      heights[HILL.row * width + HILL.col - 1] = elevation;
      heights[HILL.row * width + HILL.col + 1] = elevation;
    }
    return {
      ...emptyRenderModel(),
      bounds: mapBounds(width, height),
      projection,
      terrain: new Uint8Array(width * height),
      presence: new Uint8Array(width * height).fill(1),
      elevation: heights,
      elevationRange: { min: 0, max: elevation },
      showGrid: false,
    };
  }

  function rendererFor(source: RenderModel): HexMapRenderer {
    const renderer = new HexMapRenderer({} as CanvasRenderingContext2D, LAYOUT, new Camera());
    renderer.setModel(source);
    return renderer;
  }

  /** The screen point at the centre of the buried cell's own top face. */
  const AT_BURIED = ISOMETRIC.project(LAYOUT.centerOf(BURIED));

  it('names the buried hex without changing what a click resolves to', () => {
    const renderer = rendererFor(model(ELEVATION));

    // The hill is what is drawn there, and what a click still lands on.
    expect(renderer.resolvePointer(AT_BURIED)).toEqual({ cell: HILL, buried: BURIED });
  });

  it('hands the buried hex to a pointer that asks for it', () => {
    const renderer = rendererFor(model(ELEVATION));

    expect(renderer.resolvePointer(AT_BURIED, true).cell).toEqual(BURIED);
  });

  it('buries nothing a viewer could still aim at', () => {
    // One level of relief leaves most of the cell behind it showing, so the
    // pointer is not taken off the hill to reach it.
    const renderer = rendererFor(model(1));

    expect(renderer.buriedCellAtScreen(AT_BURIED)).toBeNull();
    expect(renderer.resolvePointer(AT_BURIED, true).cell).toEqual(BURIED);
  });

  it('buries nothing at all in top-down mode', () => {
    // A flat world hides nothing by construction: there is no relief to see
    // through (`docs/adr/ADR-0037-a-flat-map-is-drawn-from-flat-art.md`).
    const renderer = rendererFor(model(ELEVATION, 'topDown'));

    expect(renderer.buriedCellAtScreen(LAYOUT.centerOf(BURIED))).toBeNull();
  });

  it('draws what stands in front of a revealed hex see-through, or not at all', () => {
    /** Every `fill()` the frame issued, tagged with the opacity it ran at. */
    const fills: number[] = [];
    let alpha = 1;
    const stack: number[] = [];
    const context = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === 'fill') {
            return () => fills.push(alpha);
          }
          // The renderer leans on save/restore to put the opacity back, so a
          // double that ignores them would report every later fill as faded.
          if (property === 'save') {
            return () => stack.push(alpha);
          }
          if (property === 'restore') {
            return () => {
              alpha = stack.pop() ?? 1;
            };
          }
          if (property === 'measureText') {
            return () => ({ width: 0 });
          }
          return () => undefined;
        },
        set(_target, property, value) {
          if (property === 'globalAlpha') {
            alpha = Number(value);
          }
          return true;
        },
      },
    ) as CanvasRenderingContext2D;

    // A ridge, so the hex behind it is buried and so are two of its neighbours.
    const renderer = new HexMapRenderer(context, LAYOUT, new Camera());
    renderer.setModel(model(ELEVATION, 'isometric', true));

    renderer.draw(600, 600);
    const whole = [...fills];
    expect(whole.every((opacity) => opacity === 1)).toBe(true);

    renderer.setReveal(BURIED);
    fills.length = 0;
    renderer.draw(600, 600);

    const { opacity, neighbourOpacity } = emptyRenderModel().reveal;
    const ghosted = fills.filter((value) => value < 1);
    const solid = fills.filter((value) => value === 1);
    // Whatever stands in the way is drawn see-through, at the opacity the map
    // authored for the hex it hides — and at no other opacity, so nothing but
    // the relief in the way is touched.
    expect(ghosted.length).toBeGreaterThan(0);
    for (const value of ghosted) {
      expect([opacity, neighbourOpacity]).toContain(value);
    }
    // The hex the pointer holds is always one of them.
    expect(ghosted).toContain(opacity);
    // Those cells left the opaque batches, so the frame issues fewer of them.
    expect(solid.length).toBeLessThan(whole.length);

    renderer.setReveal(null);
    fills.length = 0;
    renderer.draw(600, 600);
    expect(fills).toEqual(whole);
  });
});

/**
 * Decorations: where one lands on its hex, and what it is drawn around.
 *
 * The whole point of two planes is that a character passes *between* them, so
 * the order the three are painted in is the behaviour worth pinning
 * (`docs/adr/ADR-0048-a-decoration-is-anchored-to-a-hex-in-two-planes.md`,
 * `docs/adr/ADR-0051-a-decoration-is-placed-and-the-placement-decides.md`).
 */
describe('HexMapRenderer decorations', () => {
  const HEX_SIZE = 24;
  const LAYOUT = new HexLayout(HEX_SIZE);
  const CELL = offset(1, 1);

  /** Every asset resolves, so nothing falls back for want of a download. */
  const IMAGES: SpriteSource = {
    image: (asset: string) => ({ asset }) as unknown as CanvasImageSource,
    preload: () => Promise.resolve(),
  };

  /**
   * A canvas that records the *order* of what it was asked to paint.
   *
   * `drawImage` covers the decorations; `arc` covers the entity token, which is
   * drawn with no authored character. One ordered list is what lets the test
   * say "the walker went between the two trees".
   */
  function recorder(): {
    context: CanvasRenderingContext2D;
    painted: string[];
    boxOf: (asset: string) => number[] | undefined;
  } {
    const painted: string[] = [];
    const boxes = new Map<string, number[]>();
    const context = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === 'drawImage') {
            return (
              image: { asset: string },
              x: number,
              y: number,
              width: number,
              height: number,
            ) => {
              painted.push(image.asset);
              boxes.set(image.asset, [x, y, width, height]);
            };
          }
          if (property === 'arc') {
            return () => painted.push('entity');
          }
          if (property === 'measureText') {
            return () => ({ width: 0 });
          }
          return () => undefined;
        },
        set: () => true,
      },
    ) as CanvasRenderingContext2D;
    return { context, painted, boxOf: (asset) => boxes.get(asset) };
  }

  function modelWith(): RenderModel {
    const width = 3;
    const height = 3;
    const base = emptyRenderModel();
    return {
      ...base,
      bounds: mapBounds(width, height),
      presence: new Uint8Array(width * height).fill(1),
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
        },
      ],
      terrain: new Uint8Array(width * height),
      elevation: new Int8Array(width * height),
      elevationRange: { min: 0, max: 0 },
      entities: [
        {
          id: 'p',
          at: CELL,
          visualId: 'entity.player',
          fallbackColor: '#f2c14e',
          glyph: '@',
          emphasised: false,
        },
      ],
      decorations: [
        {
          id: 'grass_0',
          at: CELL,
          plane: 'behind',
          placement: [-8, -4, 16, 8],
          asset: 'grass.png',
        },
        {
          id: 'canopy_0',
          at: CELL,
          plane: 'front',
          placement: [-16, -40, 32, 40],
          asset: 'canopy.png',
        },
      ],
    };
  }

  it('draws the character between the two planes', () => {
    const canvas = recorder();
    const renderer = new HexMapRenderer(canvas.context, LAYOUT, new Camera(), undefined, IMAGES);
    renderer.setModel(modelWith());
    renderer.draw(600, 600);

    const grass = canvas.painted.indexOf('grass.png');
    const walker = canvas.painted.indexOf('entity');
    const canopy = canvas.painted.indexOf('canopy.png');

    expect(grass).toBeGreaterThanOrEqual(0);
    expect(walker).toBeGreaterThan(grass);
    expect(canopy).toBeGreaterThan(walker);
  });

  /**
   * The other half of a map appearing dressed: a host whose definitions arrive
   * after the first model — the map editor — has to be able to ask for their
   * pictures without reloading the terrain
   * (`docs/adr/ADR-0051-a-decoration-is-placed-and-the-placement-decides.md`).
   */
  it('asks its image source for the frames the placements name', async () => {
    const asked: string[][] = [];
    const images: SpriteSource = {
      image: (asset: string) => ({ asset }) as unknown as CanvasImageSource,
      preload: (assets: Iterable<string>) => {
        asked.push([...assets]);
        return Promise.resolve();
      },
    };
    const renderer = new HexMapRenderer(
      recorder().context,
      LAYOUT,
      new Camera(),
      undefined,
      images,
    );
    renderer.setModel(modelWith());

    await renderer.warmDecorations();
    // Once per distinct image, not once per tree.
    expect(asked).toEqual([['grass.png', 'canopy.png']]);

    // A map with nothing standing on it asks for nothing at all.
    renderer.setModel({ ...modelWith(), decorations: [] });
    await renderer.warmDecorations();
    expect(asked).toHaveLength(1);
  });

  it('lands the placement on the cell ground point, at the tile scale', () => {
    const canvas = recorder();
    const model = modelWith();
    const renderer = new HexMapRenderer(canvas.context, LAYOUT, new Camera(), undefined, IMAGES);
    renderer.setModel(model);
    renderer.draw(600, 600);

    const box = canvas.boxOf('canopy.png');
    const ground = LAYOUT.centerOf(CELL);
    // One authored tile pixel is one hex width over the grid the art was drawn
    // on — the same scale a painted cell is blitted at.
    const perPixel = LAYOUT.hexWidth / model.tileArt.width;

    expect(box?.[0]).toBeCloseTo(ground.x - 16 * perPixel, 6);
    expect(box?.[1]).toBeCloseTo(ground.y - 40 * perPixel, 6);
    expect(box?.[2]).toBeCloseTo(32 * perPixel, 6);
    expect(box?.[3]).toBeCloseTo(40 * perPixel, 6);
  });
});

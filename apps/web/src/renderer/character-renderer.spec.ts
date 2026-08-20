import { describe, expect, it, vi } from 'vitest';

import { PixelRect, ResolvedCharacter, ResolvedLayer } from '../content/content-types';
import {
  CharacterBox,
  SpriteCache,
  SpriteSource,
  drawCharacter,
  pixelUnder,
  placement,
} from './character-renderer';

/**
 * A sprite source over a fixed answer.
 *
 * Drawing never preloads — it is the caller that says in advance what it will
 * need — so these doubles resolve that half of the interface and say no more.
 */
function sourceOf(image: (asset: string) => CanvasImageSource | null): SpriteSource {
  return { image, preload: () => Promise.resolve() };
}

/**
 * The renderer's whole job is putting authored pixels on screen without moving
 * them: a whole-number zoom, integer destinations, no smoothing. Everything
 * upstream — which variant, which tint, which box — was decided by the Rust
 * resolver, so these tests record calls rather than pixels.
 */
function recordingContext(pixels?: number[]) {
  const data = Uint8ClampedArray.from(pixels ?? []);
  return {
    fillStyle: '',
    strokeStyle: '',
    imageSmoothingEnabled: true,
    globalCompositeOperation: 'source-over',
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    drawImage: vi.fn(),
    setLineDash: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    // The scratch canvas of `tinted()`: what `drawImage` put there is whatever
    // the caller seeded, and the tint is arithmetic on it.
    getImageData: vi.fn(() => ({ data })),
    putImageData: vi.fn(),
    data,
  };
}

const BOX: CharacterBox = { x: 0, y: 0, width: 200, height: 400 };
const CANVAS = { width: 64, height: 128 };

/**
 * A resolved character the renderer can draw.
 *
 * `offset` is filled in here rather than at every call: it is what the
 * animation moved a layer by and `origin` is the frame its box was measured
 * from — both already applied to `rect`, and the renderer reads neither
 * (`docs/adr/ADR-0034-layer-boxes-are-anchor-relative.md`).
 */
function character(
  layers: Omit<ResolvedLayer, 'offset' | 'origin'>[],
  mirrored = false,
): ResolvedCharacter {
  return {
    character: 'c',
    category: 'player',
    resolution: CANVAS,
    values: {},
    mirrored,
    layers: layers.map((layer) => ({ ...layer, offset: [0, 0], origin: [0, 0] })),
  };
}

describe('placement', () => {
  it('zooms by whole pixels and stands the character on the bottom of the box', () => {
    // 200/64 = 3.1, 400/128 = 3.1 → 3, never 3.125.
    expect(placement(CANVAS, BOX)).toEqual({ zoom: 3, originX: 4, originY: 16 });
  });

  it('never zooms below 1, however small the box', () => {
    expect(placement(CANVAS, { x: 0, y: 0, width: 10, height: 10 }).zoom).toBe(1);
  });

  it('fits whichever side is tighter', () => {
    // Wide and short: the height decides.
    expect(placement(CANVAS, { x: 0, y: 0, width: 1000, height: 260 }).zoom).toBe(2);
  });
});

describe('pixelUnder', () => {
  const VIEW = placement(CANVAS, BOX);
  // Canvas pixel (10, 20) is drawn at 4 + 30 .. 37 across and 16 + 60 .. 79
  // down, so its middle is here.
  const MIDDLE = { x: 35.5, y: 77.5 };

  it('finds the canvas pixel a point is over', () => {
    const bounds = { left: 0, top: 0, width: BOX.width, height: BOX.height };

    expect(pixelUnder(MIDDLE, bounds, BOX, VIEW)).toEqual({ x: 10, y: 20 });
  });

  it('finds the same pixel when the shell is zoomed under it', () => {
    // What the interface scale does (`app/app.css`): the element is rendered a
    // quarter larger and moved, while the box it was drawn in has not changed.
    // Reading the pointer in drawn pixels would land a click a quarter of the
    // way further into the canvas — further the further from the origin it is.
    const scale = 1.25;
    const bounds = {
      left: 100,
      top: 50,
      width: BOX.width * scale,
      height: BOX.height * scale,
    };
    const onScreen = { x: 100 + MIDDLE.x * scale, y: 50 + MIDDLE.y * scale };

    expect(pixelUnder(onScreen, bounds, BOX, VIEW)).toEqual({ x: 10, y: 20 });
  });

  it('agrees with the placement at every corner of a pixel', () => {
    const bounds = { left: 0, top: 0, width: BOX.width, height: BOX.height };
    const first = { x: 4, y: 16 };

    expect(pixelUnder(first, bounds, BOX, VIEW)).toEqual({ x: 0, y: 0 });
    // One pixel short of the next block, and one pixel into it.
    expect(pixelUnder({ x: 6.9, y: 18.9 }, bounds, BOX, VIEW)).toEqual({ x: 0, y: 0 });
    expect(pixelUnder({ x: 7, y: 19 }, bounds, BOX, VIEW)).toEqual({ x: 1, y: 1 });
  });

  it('reports pixels outside the canvas rather than clamping them', () => {
    const bounds = { left: 0, top: 0, width: BOX.width, height: BOX.height };

    // The margin above the character, which is off its canvas: the caller
    // decides what that means, because only it knows which sprite it is over.
    expect(pixelUnder({ x: 1, y: 1 }, bounds, BOX, VIEW)).toEqual({ x: -1, y: -5 });
  });

  it('answers nothing for an element with no size', () => {
    expect(pixelUnder(MIDDLE, { left: 0, top: 0, width: 0, height: 0 }, BOX, VIEW)).toBeNull();
  });
});

describe('drawCharacter', () => {
  /**
   * The one drawing decision this file makes: a mirrored character is the
   * whole canvas reflected about its own centre line, layers and pixels
   * together (`docs/adr/ADR-0031-characters-animate-by-hierarchy-and-offsets.md`).
   */
  it('reflects a mirrored character about its own canvas, not its box', () => {
    const context = recordingContext();
    const image = {} as CanvasImageSource;
    const layers = [
      {
        layer: 'legs',
        variant: 'stride',
        rect: [18, 66, 28, 57] as const,
        asset: 'a.png',
        tint: '',
      },
    ];

    drawCharacter(
      context as unknown as CanvasRenderingContext2D,
      character(
        layers.map((layer) => ({ ...layer, rect: [...layer.rect] as PixelRect })),
        true,
      ),
      BOX,
      sourceOf(() => image),
    );

    // placement(): zoom 3, originX 4. The canvas is 64 wide, so the axis sits
    // at 4 + 64 * 3 / 2 and the translation is twice that.
    expect(context.translate).toHaveBeenCalledWith(4 * 2 + 64 * 3, 0);
    expect(context.scale).toHaveBeenCalledWith(-1, 1);
    // Saved and restored, so the mirror does not leak into whatever draws next.
    expect(context.save).toHaveBeenCalled();
    expect(context.restore).toHaveBeenCalled();
    // Smoothing is re-asserted after the flip: some engines reset it there,
    // and a smoothed sprite is the whole thing this pipeline avoids.
    expect(context.imageSmoothingEnabled).toBe(false);
    // The boxes are untouched — only the canvas moved.
    expect(context.drawImage).toHaveBeenCalledWith(image, 4 + 18 * 3, 16 + 66 * 3, 28 * 3, 57 * 3);
  });

  it('draws an unmirrored character without touching the transform', () => {
    const context = recordingContext();
    drawCharacter(
      context as unknown as CanvasRenderingContext2D,
      character([
        { layer: 'body', variant: 'd', rect: [21, 12, 22, 54], asset: 'a.png', tint: '' },
      ]),
      BOX,
      sourceOf(() => ({}) as CanvasImageSource),
    );
    expect(context.translate).not.toHaveBeenCalled();
    expect(context.scale).not.toHaveBeenCalled();
  });

  it('turns off smoothing and blits each sprite at the zoomed box', () => {
    const context = recordingContext();
    const image = {} as CanvasImageSource;

    drawCharacter(
      context as unknown as CanvasRenderingContext2D,
      character([
        {
          layer: 'body',
          variant: 'default',
          rect: [21, 12, 22, 107],
          asset: 'assets/characters/body.png',
          tint: '',
        },
      ]),
      BOX,
      sourceOf(() => image),
    );

    expect(context.imageSmoothingEnabled).toBe(false);
    // origin (4, 16) + 21*3, 12*3 — and the size is the authored one times 3.
    expect(context.drawImage).toHaveBeenCalledWith(image, 67, 52, 66, 321);
  });

  it('draws layers back to front, in the order the resolver produced', () => {
    const context = recordingContext();
    const drawn: string[] = [];
    const images = new Map<string, CanvasImageSource>([
      ['back.png', {} as CanvasImageSource],
      ['front.png', {} as CanvasImageSource],
    ]);
    context.drawImage.mockImplementation((image: CanvasImageSource) => {
      drawn.push([...images].find(([, value]) => value === image)?.[0] ?? '?');
    });

    drawCharacter(
      context as unknown as CanvasRenderingContext2D,
      character([
        { layer: 'cape', variant: 'v', rect: [0, 0, 64, 128], asset: 'back.png', tint: '' },
        { layer: 'hair', variant: 'v', rect: [0, 0, 64, 128], asset: 'front.png', tint: '' },
      ]),
      BOX,
      sourceOf((asset) => images.get(asset) ?? null),
    );

    expect(drawn).toEqual(['back.png', 'front.png']);
  });

  it('outlines a sprite whose image is not there, so a layer can still be placed', () => {
    const context = recordingContext();

    drawCharacter(
      context as unknown as CanvasRenderingContext2D,
      character([
        { layer: 'hair', variant: 'v', rect: [0, 0, 64, 128], asset: 'absent.png', tint: '' },
      ]),
      BOX,
      sourceOf(() => null),
    );

    expect(context.strokeRect).toHaveBeenCalled();
    expect(context.drawImage).not.toHaveBeenCalled();
  });

  it('skips a layer with a box of no size', () => {
    const context = recordingContext();

    drawCharacter(
      context as unknown as CanvasRenderingContext2D,
      character([{ layer: 'flat', variant: 'v', rect: [10, 10, 0, 20], asset: 'a.png', tint: '' }]),
      BOX,
      sourceOf(() => ({}) as CanvasImageSource),
    );

    expect(context.drawImage).not.toHaveBeenCalled();
  });

  /**
   * A tinted sprite goes through an offscreen canvas, so what reaches the page
   * is the recoloured sprite rather than a rectangle of paint.
   */
  it('recolours a tinted sprite through an offscreen canvas', () => {
    const scratch = recordingContext([255, 255, 255, 255]);
    const element = { width: 0, height: 0, getContext: () => scratch };
    const created = vi
      .spyOn(document, 'createElement')
      .mockReturnValue(element as unknown as HTMLElement);
    const context = recordingContext();
    const image = {} as CanvasImageSource;

    try {
      drawCharacter(
        context as unknown as CanvasRenderingContext2D,
        character([
          {
            layer: 'hair',
            variant: 'long',
            rect: [20, 8, 24, 30],
            asset: 'hair.png',
            tint: '#8b5a2b',
          },
        ]),
        BOX,
        sourceOf(() => image),
      );
    } finally {
      created.mockRestore();
    }

    // The scratch canvas is the sprite's own size, not the zoomed one.
    expect(element.width).toBe(24);
    expect(element.height).toBe(30);
    // A white pixel comes out as the tint itself: that is what makes one
    // greyscale sprite serve every colour.
    expect([...scratch.data]).toEqual([0x8b, 0x5a, 0x2b, 255]);
    expect(scratch.putImageData).toHaveBeenCalled();
    // What lands on the page is the scratch canvas, at the zoomed box.
    expect(context.drawImage).toHaveBeenCalledWith(element, 64, 40, 72, 90);
  });

  /**
   * The reason ADR-0030 forbade partial alpha on a character, and the reason
   * ADR-0039 could allow it.
   *
   * The old pipeline multiplied an opaque fill over the scratch canvas, which
   * blends *and* composites: where a pixel was half there, half the tint
   * arrived at full strength, so a mid-grey at alpha 128 came back at roughly
   * `(105, 68, 32)` — visibly paler than its own shade, a halo in the tint's
   * colour. Multiplying the RGB and leaving the alpha alone gives the shade it
   * was drawn as, at the alpha it was drawn at.
   */
  it('tints a half-transparent pixel by its shade, not toward the flat tint', () => {
    const scratch = recordingContext([128, 128, 128, 128, 0, 0, 0, 0]);
    const element = { width: 0, height: 0, getContext: () => scratch };
    const created = vi
      .spyOn(document, 'createElement')
      .mockReturnValue(element as unknown as HTMLElement);
    const image = {} as CanvasImageSource;

    try {
      drawCharacter(
        recordingContext() as unknown as CanvasRenderingContext2D,
        character([
          { layer: 'hair', variant: 'soft', rect: [0, 0, 2, 1], asset: 'h.png', tint: '#8b5a2b' },
        ]),
        BOX,
        sourceOf(() => image),
      );
    } finally {
      created.mockRestore();
    }

    // 128 x 139 / 255, 128 x 90 / 255, 128 x 43 / 255 — and the alpha untouched.
    expect([...scratch.data].slice(0, 4)).toEqual([70, 45, 22, 128]);
    // A fully clear pixel is left exactly as it was: no tint spills into the
    // transparent margin.
    expect([...scratch.data].slice(4)).toEqual([0, 0, 0, 0]);
  });

  /** An unreadable tint leaves the sprite alone rather than painting it black. */
  it('draws the sprite as authored when the tint is not a colour', () => {
    const scratch = recordingContext([200, 100, 50, 255]);
    const element = { width: 0, height: 0, getContext: () => scratch };
    const created = vi
      .spyOn(document, 'createElement')
      .mockReturnValue(element as unknown as HTMLElement);
    const image = {} as CanvasImageSource;

    try {
      drawCharacter(
        recordingContext() as unknown as CanvasRenderingContext2D,
        character([
          { layer: 'hair', variant: 'v', rect: [0, 0, 1, 1], asset: 'h.png', tint: 'not a colour' },
        ]),
        BOX,
        sourceOf(() => image),
      );
    } finally {
      created.mockRestore();
    }

    expect([...scratch.data]).toEqual([200, 100, 50, 255]);
    expect(scratch.putImageData).not.toHaveBeenCalled();
  });
});

/**
 * The cache's two jobs beyond holding images: fetching what is about to be
 * needed, and not shouting about it
 * (`docs/adr/ADR-0038-a-map-is-drawn-from-shared-pictures.md`).
 */
describe('SpriteCache', () => {
  /** An `Image` whose loads are fired by the test, not by a network. */
  class ScriptedImage {
    static pending: { url: string; load: () => void; fail: () => void }[] = [];
    private readonly handlers = new Map<string, () => void>();

    addEventListener(type: string, handler: () => void): void {
      this.handlers.set(type, handler);
    }

    set src(url: string) {
      ScriptedImage.pending.push({
        url,
        load: () => this.handlers.get('load')?.(),
        fail: () => this.handlers.get('error')?.(),
      });
    }
  }

  /**
   * Runs `body` with the scripted image installed.
   *
   * `await`ed inside the `try`, deliberately: returning the promise would put
   * the real `Image` back at the body's first suspension point, and everything
   * after it would quietly fetch for real.
   */
  async function scripted<T>(body: () => Promise<T>): Promise<T> {
    const previous = globalThis.Image;
    ScriptedImage.pending = [];
    globalThis.Image = ScriptedImage as unknown as typeof Image;
    try {
      return await body();
    } finally {
      globalThis.Image = previous;
    }
  }

  /** Long enough for a booked animation frame — or its microtask stand-in. */
  const nextFrame = (): Promise<void> => new Promise((done) => setTimeout(done, 32));

  it('resolves a preload once every asset has settled, missing ones included', async () => {
    await scripted(async () => {
      const cache = new SpriteCache((asset) => `/content/${asset}`);
      let settled = false;
      const warmed = cache.preload(['a.png', 'b.png']).then(() => {
        settled = true;
      });

      expect(ScriptedImage.pending).toHaveLength(2);
      ScriptedImage.pending[0]?.load();
      await nextFrame();
      // One of two is not "loaded": the caller is waiting for the whole map.
      expect(settled).toBe(false);

      // A file that is not there answers too, or the map never draws at all.
      ScriptedImage.pending[1]?.fail();
      await warmed;
      expect(settled).toBe(true);
      expect(cache.image('a.png')).not.toBeNull();
      expect(cache.image('b.png')).toBeNull();
    });
  });

  it('fetches an asset once, however many times it is asked for', async () => {
    await scripted(async () => {
      const cache = new SpriteCache((asset) => asset);
      cache.image('grass.png');
      cache.image('grass.png');
      void cache.preload(['grass.png']);

      expect(ScriptedImage.pending).toHaveLength(1);
    });
  });

  it('drops a fetch that finishes after the cache was cleared', async () => {
    await scripted(async () => {
      const cache = new SpriteCache((asset) => asset);
      cache.image('hair.png');
      const stale = ScriptedImage.pending[0];

      // The author repainted the file; everything held is now the old version.
      cache.clear();
      stale?.load();
      await nextFrame();

      // The old fetch answered into a cache that no longer wants it, and the
      // next request goes back to the file (ADR-0030).
      expect(cache.image('hair.png')).toBeNull();
      expect(ScriptedImage.pending).toHaveLength(2);
    });
  });

  it('announces a burst of arrivals once, not once per image', async () => {
    await scripted(async () => {
      let redraws = 0;
      const cache = new SpriteCache(
        (asset) => asset,
        () => {
          redraws += 1;
        },
      );
      void cache.preload(['a.png', 'b.png', 'c.png', 'd.png']);
      for (const image of ScriptedImage.pending) {
        image.load();
      }
      await nextFrame();

      // Four images, one redraw: nothing anyone can see happens between two of
      // them, and each redraw used to rebuild the whole render model.
      expect(redraws).toBe(1);
    });
  });
});

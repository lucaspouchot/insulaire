import { describe, expect, it, vi } from 'vitest';

import { PixelRect, ResolvedCharacter, ResolvedLayer } from '../content/content-types';
import { CharacterBox, drawCharacter, pixelUnder, placement } from './character-renderer';

/**
 * The renderer's whole job is putting authored pixels on screen without moving
 * them: a whole-number zoom, integer destinations, no smoothing. Everything
 * upstream — which variant, which tint, which box — was decided by the Rust
 * resolver, so these tests record calls rather than pixels.
 */
function recordingContext() {
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
      { image: () => image },
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
      { image: () => ({}) as CanvasImageSource },
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
      { image: () => image },
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
      { image: (asset) => images.get(asset) ?? null },
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
      { image: () => null },
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
      { image: () => ({}) as CanvasImageSource },
    );

    expect(context.drawImage).not.toHaveBeenCalled();
  });

  /**
   * A tinted sprite goes through an offscreen canvas — multiply for the shading,
   * then `destination-in` to put the alpha back — so what reaches the page is
   * the recoloured sprite rather than a rectangle of paint.
   */
  it('recolours a tinted sprite through an offscreen canvas', () => {
    const scratch = recordingContext();
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
        { image: () => image },
      );
    } finally {
      created.mockRestore();
    }

    // The scratch canvas is the sprite's own size, not the zoomed one.
    expect(element.width).toBe(24);
    expect(element.height).toBe(30);
    expect(scratch.fillStyle).toBe('#8b5a2b');
    expect(scratch.globalCompositeOperation).toBe('destination-in');
    // What lands on the page is the scratch canvas, at the zoomed box.
    expect(context.drawImage).toHaveBeenCalledWith(element, 64, 40, 72, 90);
  });
});

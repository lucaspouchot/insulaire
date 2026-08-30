import { describe, expect, it } from 'vitest';

import {
  MAX_DENSITY,
  PIXEL_ZOOMS,
  fitZoom,
  prepareSurface,
  surfaceDensity,
  zoomBy,
} from './canvas-surface';

/**
 * A context that records what was done to it.
 *
 * No canvas and no DOM: the whole reason this module takes a context rather
 * than being a component is that its arithmetic can be read back without one,
 * the same bargain `HexMapRenderer` makes
 * (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`).
 */
function contextDouble(): {
  context: CanvasRenderingContext2D;
  canvas: { width: number; height: number; style: { width: string; height: string } };
  transforms: number[][];
  cleared: number[][];
} {
  const canvas = { width: 0, height: 0, style: { width: '', height: '' } };
  const transforms: number[][] = [];
  const cleared: number[][] = [];
  const context = {
    canvas,
    setTransform: (...args: number[]) => transforms.push(args),
    clearRect: (...args: number[]) => cleared.push(args),
  } as unknown as CanvasRenderingContext2D;

  return { context, canvas, transforms, cleared };
}

describe('surfaceDensity', () => {
  it('draws one CSS pixel as one device pixel on an ordinary screen', () => {
    expect(surfaceDensity({ width: 400, height: 300 }, { devicePixelRatio: 1 })).toBe(1);
  });

  it('follows the device on a retina screen', () => {
    expect(surfaceDensity({ width: 400, height: 300 }, { devicePixelRatio: 2 })).toBe(2);
  });

  it('caps what any surface in this application will ask for', () => {
    expect(surfaceDensity({ width: 400, height: 300 }, { devicePixelRatio: 4 })).toBe(MAX_DENSITY);
    expect(surfaceDensity({ width: 400, height: 300 }, { devicePixelRatio: 8 })).toBe(MAX_DENSITY);
  });

  it('survives a browser reporting no ratio at all', () => {
    expect(surfaceDensity({ width: 400, height: 300 }, { devicePixelRatio: 0 })).toBe(1);
    expect(surfaceDensity({ width: 400, height: 300 }, { devicePixelRatio: Number.NaN })).toBe(1);
  });

  it('drops the ratio once one authored pixel is already a block of screen pixels', () => {
    const stage = { width: 256, height: 256 };

    expect(surfaceDensity(stage, { devicePixelRatio: 3, zoom: 3 })).toBe(3);
    expect(surfaceDensity(stage, { devicePixelRatio: 3, zoom: 4 })).toBe(1);
    expect(surfaceDensity(stage, { devicePixelRatio: 3, zoom: 16 })).toBe(1);
  });

  it('multiplies by whatever else is scaling the page', () => {
    expect(surfaceDensity({ width: 100, height: 100 }, { devicePixelRatio: 2, scale: 1.25 })).toBe(
      2.5,
    );
  });

  it('gives up density rather than ask a tab for a backing store it cannot hold', () => {
    expect(
      surfaceDensity({ width: 1000, height: 500 }, { devicePixelRatio: 3, maxSide: 4096 }),
    ).toBe(3);
    expect(
      surfaceDensity({ width: 3000, height: 500 }, { devicePixelRatio: 3, maxSide: 4096 }),
    ).toBeCloseTo(4096 / 3000);
  });

  it('reads the window when the caller says nothing', () => {
    expect(surfaceDensity({ width: 100, height: 100 })).toBe(
      Math.min(globalThis.devicePixelRatio || 1, MAX_DENSITY),
    );
  });
});

describe('prepareSurface', () => {
  it('sizes the backing store in device pixels and the element in CSS pixels', () => {
    const { context, canvas } = contextDouble();

    prepareSurface(context, { width: 400, height: 300 }, { devicePixelRatio: 2 });

    expect(canvas).toMatchObject({ width: 800, height: 600 });
    expect(canvas.style).toEqual({ width: '400px', height: '300px' });
  });

  it('leaves the context drawing in CSS pixels, cleared', () => {
    const { context, transforms, cleared } = contextDouble();

    prepareSurface(context, { width: 400, height: 300 }, { devicePixelRatio: 2 });

    expect(transforms).toEqual([[2, 0, 0, 2, 0, 0]]);
    expect(cleared).toEqual([[0, 0, 400, 300]]);
  });

  it('reports the density it used, which is what a hit test divides by', () => {
    const { context } = contextDouble();

    expect(
      prepareSurface(context, { width: 100, height: 100 }, { devicePixelRatio: 3, zoom: 8 }),
    ).toBe(1);
  });

  it('never asks for a zero-sided backing store', () => {
    const { context, canvas } = contextDouble();

    prepareSurface(context, { width: 0, height: 0 }, { devicePixelRatio: 1 });

    expect(canvas).toMatchObject({ width: 1, height: 1 });
  });
});

describe('fitZoom', () => {
  it('is the largest whole zoom the content fits at', () => {
    expect(fitZoom({ width: 32, height: 32 }, { width: 320, height: 320 })).toBe(10);
    expect(fitZoom({ width: 32, height: 32 }, { width: 320, height: 100 })).toBe(3);
  });

  it('leaves the padding asked for on every side', () => {
    expect(fitZoom({ width: 32, height: 32 }, { width: 320, height: 320 }, 12)).toBe(9);
  });

  it('never goes below 1, so content too big to fit is clipped rather than smeared', () => {
    expect(fitZoom({ width: 512, height: 512 }, { width: 100, height: 100 })).toBe(1);
    expect(fitZoom({ width: 32, height: 32 }, { width: 0, height: 0 })).toBe(1);
  });

  it('survives content with no size', () => {
    expect(fitZoom({ width: 0, height: 0 }, { width: 320, height: 320 })).toBe(320);
  });
});

describe('zoomBy', () => {
  it('steps up and down the ladder', () => {
    expect(zoomBy(8, 1)).toBe(12);
    expect(zoomBy(8, -1)).toBe(6);
  });

  it('stops at both ends rather than wrapping', () => {
    const last = PIXEL_ZOOMS[PIXEL_ZOOMS.length - 1] ?? 1;

    expect(zoomBy(1, -1)).toBe(1);
    expect(zoomBy(last, 1)).toBe(last);
  });

  it('takes the first step in the direction asked from a fitted zoom off the ladder', () => {
    expect(zoomBy(7, 1)).toBe(8);
    expect(zoomBy(7, -1)).toBe(6);
    expect(zoomBy(0.5, -1)).toBe(1);
    expect(zoomBy(100, 1)).toBe(32);
  });
});

import { describe, expect, it, vi } from 'vitest';

import { ResolvedCharacter } from '../content/content-types';
import { CharacterBox, drawCharacter, place } from './character-renderer';

/**
 * The renderer's whole job is turning unit boxes into canvas boxes and picking
 * the right primitive. Everything upstream of that — which variant, what
 * colour, how tall — was decided by the Rust resolver, so these tests record
 * calls rather than pixels.
 */
function recordingContext() {
  return {
    fillStyle: '',
    strokeStyle: '',
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    beginPath: vi.fn(),
    ellipse: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    drawImage: vi.fn(),
    setLineDash: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
  };
}

const BOX: CharacterBox = { x: 10, y: 20, width: 200, height: 400 };

function character(layers: ResolvedCharacter['layers']): ResolvedCharacter {
  return { character: 'c', category: 'player', values: {}, layers };
}

describe('place', () => {
  it('maps the unit square onto the box it is drawn in', () => {
    expect(place([0, 0, 1, 1], BOX)).toEqual(BOX);
    expect(place([0.5, 0.25, 0.5, 0.5], BOX)).toEqual({
      x: 110,
      y: 120,
      width: 100,
      height: 200,
    });
  });
});

describe('drawCharacter', () => {
  it('draws each shape with the colour the resolver produced', () => {
    const context = recordingContext();
    drawCharacter(
      context as unknown as CanvasRenderingContext2D,
      character([
        {
          layer: 'body',
          variant: 'default',
          rect: [0, 0.5, 1, 0.5],
          visual: { kind: 'shape', shape: 'rect', color: '#7a5c3e' },
        },
        {
          layer: 'head',
          variant: 'default',
          rect: [0.25, 0, 0.5, 0.5],
          visual: { kind: 'shape', shape: 'ellipse', color: '#e8c39e' },
        },
      ]),
      BOX,
    );

    expect(context.fillRect).toHaveBeenCalledWith(10, 220, 200, 200);
    // Centre and radii, not corner and size.
    expect(context.ellipse).toHaveBeenCalledWith(110, 120, 50, 100, 0, 0, Math.PI * 2);
    // The last colour set is the one the last layer asked for.
    expect(context.fillStyle).toBe('#e8c39e');
  });

  it('draws a triangle standing on the bottom edge of its box', () => {
    const context = recordingContext();
    drawCharacter(
      context as unknown as CanvasRenderingContext2D,
      character([
        {
          layer: 'skirt',
          variant: 'female',
          rect: [0, 0, 1, 1],
          visual: { kind: 'shape', shape: 'triangle', color: '#7a5c3e' },
        },
      ]),
      BOX,
    );

    expect(context.moveTo).toHaveBeenCalledWith(10, 420);
    expect(context.lineTo).toHaveBeenNthCalledWith(1, 210, 420);
    expect(context.lineTo).toHaveBeenNthCalledWith(2, 110, 20);
  });

  it('blits a sprite when its image is there and outlines it when it is not', () => {
    const context = recordingContext();
    const image = {} as CanvasImageSource;
    const layers: ResolvedCharacter['layers'] = [
      {
        layer: 'clothes',
        variant: 'plain',
        rect: [0, 0, 1, 1],
        visual: { kind: 'sprite', asset: 'assets/characters/plain.png' },
      },
    ];

    drawCharacter(context as unknown as CanvasRenderingContext2D, character(layers), BOX, {
      image: () => image,
    });
    expect(context.drawImage).toHaveBeenCalledWith(image, 10, 20, 200, 400);

    // A missing image leaves an outline, so a layer being placed stays visible.
    drawCharacter(context as unknown as CanvasRenderingContext2D, character(layers), BOX, {
      image: () => null,
    });
    expect(context.strokeRect).toHaveBeenCalledWith(10, 20, 200, 400);
    expect(context.drawImage).toHaveBeenCalledTimes(1);
  });

  it('draws layers back to front, in the order the resolver produced', () => {
    const context = recordingContext();
    const order: string[] = [];
    context.fillRect.mockImplementation(() => order.push('rect'));
    context.fill.mockImplementation(() => order.push('ellipse'));

    drawCharacter(
      context as unknown as CanvasRenderingContext2D,
      character([
        {
          layer: 'body',
          variant: 'v',
          rect: [0, 0, 1, 1],
          visual: { kind: 'shape', shape: 'rect', color: '#000' },
        },
        {
          layer: 'head',
          variant: 'v',
          rect: [0, 0, 1, 1],
          visual: { kind: 'shape', shape: 'ellipse', color: '#fff' },
        },
      ]),
      BOX,
    );

    expect(order).toEqual(['rect', 'ellipse']);
  });

  it('skips a layer with nothing to draw', () => {
    const context = recordingContext();
    drawCharacter(
      context as unknown as CanvasRenderingContext2D,
      character([
        {
          layer: 'flat',
          variant: 'v',
          rect: [0.5, 0.5, 0, 0.2],
          visual: { kind: 'shape', shape: 'rect', color: '#000' },
        },
      ]),
      BOX,
    );

    expect(context.fillRect).not.toHaveBeenCalled();
  });
});

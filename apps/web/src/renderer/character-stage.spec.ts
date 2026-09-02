import { describe, expect, it, vi } from 'vitest';

import { CharacterLayer, ResolvedCharacter, ResolvedLayer } from '../content/generated/character';
import { CharacterBox, SpriteSource } from './character-renderer';
import {
  CharacterStage,
  CharacterStageChrome,
  NO_STAGE_CHROME,
  paintedFor,
} from './character-stage';

/**
 * The stage's whole job is putting the resolver's answer on a canvas and adding
 * the overlays only an editor needs, so — like the map renderer's spec — these
 * tests record context calls rather than inspect pixels.
 */
function recorder(bounds = { left: 0, top: 0, width: 200, height: 400 }) {
  const calls: Record<string, unknown[][]> = {};
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      (calls[name] ??= []).push(args);
    };
  const context = {
    canvas: { getBoundingClientRect: () => bounds },
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    imageSmoothingEnabled: true,
    save: vi.fn(record('save')),
    restore: vi.fn(record('restore')),
    translate: vi.fn(record('translate')),
    scale: vi.fn(record('scale')),
    fillRect: vi.fn(record('fillRect')),
    strokeRect: vi.fn(record('strokeRect')),
    drawImage: vi.fn(record('drawImage')),
    setLineDash: vi.fn(record('setLineDash')),
    beginPath: vi.fn(record('beginPath')),
    moveTo: vi.fn(record('moveTo')),
    lineTo: vi.fn(record('lineTo')),
    stroke: vi.fn(record('stroke')),
    arc: vi.fn(record('arc')),
    fill: vi.fn(record('fill')),
  };
  return { context: context as unknown as CanvasRenderingContext2D, calls };
}

const IMAGE = {} as CanvasImageSource;

function source(image: (asset: string) => CanvasImageSource | null = () => IMAGE): SpriteSource {
  return { image, preload: () => Promise.resolve() };
}

function layer(
  over: Partial<ResolvedLayer> & Pick<ResolvedLayer, 'layer' | 'rect'>,
): ResolvedLayer {
  return {
    variant: `${over.layer}-v`,
    origin: [0, 0],
    offset: [0, 0],
    asset: `${over.layer}.png`,
    tint: '',
    ...over,
  };
}

function character(over: Partial<ResolvedCharacter> = {}): ResolvedCharacter {
  return {
    character: 'c',
    category: 'player',
    resolution: { width: 64, height: 128 },
    values: {},
    mirrored: false,
    layers: [layer({ layer: 'body', rect: [0, 0, 64, 128] })],
    ...over,
  };
}

const BOX: CharacterBox = { x: 0, y: 0, width: 200, height: 400 };

function chrome(over: Partial<CharacterStageChrome> = {}): CharacterStageChrome {
  return { ...NO_STAGE_CHROME, ...over };
}

function model(over: Partial<Parameters<CharacterStage['setModel']>[0]> = {}) {
  return {
    character: character(),
    box: BOX,
    chrome: NO_STAGE_CHROME,
    layers: [] as readonly CharacterLayer[],
    transparencyColors: ['#0d1117', '#1c242f'] as readonly [string, string],
    ...over,
  };
}

describe('CharacterStage drawing', () => {
  it('places the character at the fitted whole zoom and reports it', () => {
    const { context } = recorder();
    const stage = new CharacterStage(context, source());

    stage.setModel(model());
    stage.draw();

    // 200/64 and 400/128 both floor to 3.
    expect(stage.zoom).toBe(3);
    // The one body layer, drawn at the placement placement() gives.
    expect(context.drawImage).toHaveBeenCalledWith(IMAGE, 4, 16, 64 * 3, 128 * 3);
  });

  it('draws nothing until it has a model', () => {
    const { context } = recorder();
    const stage = new CharacterStage(context, source());

    stage.draw();

    expect(context.drawImage).not.toHaveBeenCalled();
    expect(stage.zoom).toBe(1);
  });

  it('strokes no editor chrome when every option is off', () => {
    const { context, calls } = recorder();
    const stage = new CharacterStage(context, source());

    stage.setModel(model({ chrome: NO_STAGE_CHROME }));
    stage.draw();

    expect(calls['fillRect']).toBeUndefined();
    expect(calls['strokeRect']).toBeUndefined();
    expect(context.drawImage).toHaveBeenCalledTimes(1);
  });

  it('paints the transparency checker over the authored canvas', () => {
    const { context, calls } = recorder();
    const stage = new CharacterStage(context, source());

    stage.setModel(model({ chrome: chrome({ showTransparency: true }) }));
    stage.draw();

    // The light ground covers the whole authored canvas at the placement.
    expect(context.fillRect).toHaveBeenCalledWith(4, 16, 64 * 3, 128 * 3);
    // And at least one dark square lands on top of it.
    expect((calls['fillRect'] ?? []).length).toBeGreaterThan(1);
  });

  it('outlines the authored canvas with a dashed rectangle', () => {
    const { context } = recorder();
    const stage = new CharacterStage(context, source());

    stage.setModel(model({ chrome: chrome({ canvasBounds: true }) }));
    stage.draw();

    expect(context.setLineDash).toHaveBeenCalledWith([2, 3]);
    expect(context.strokeRect).toHaveBeenCalledWith(4.5, 16.5, 64 * 3 - 1, 128 * 3 - 1);
  });

  it('boxes the open layer where the resolver drew it', () => {
    const { context } = recorder();
    const stage = new CharacterStage(context, source());
    const resolved = character({
      layers: [
        layer({ layer: 'body', rect: [0, 0, 64, 128] }),
        layer({ layer: 'head', rect: [20, 4, 16, 16] }),
      ],
    });

    stage.setModel(model({ character: resolved, chrome: chrome({ openLayerId: 'head' }) }));
    stage.draw();

    expect(context.strokeRect).toHaveBeenCalledWith(
      4 + 20 * 3 - 0.5,
      16 + 4 * 3 - 0.5,
      16 * 3 + 1,
      16 * 3 + 1,
    );
  });

  it('draws the pixel grid once the zoom is large enough to aim at', () => {
    const { context, calls } = recorder();
    const stage = new CharacterStage(context, source());
    const resolved = character({
      resolution: { width: 16, height: 16 },
      layers: [layer({ layer: 'body', rect: [0, 0, 16, 16] })],
    });

    stage.setModel(
      model({
        character: resolved,
        box: { x: 0, y: 0, width: 200, height: 200 },
        chrome: chrome({ showGrid: true }),
      }),
    );
    stage.draw();

    // zoom 12 ≥ GRID_ZOOM: one interior line per authored pixel, both axes.
    expect(stage.zoom).toBe(12);
    expect((calls['moveTo'] ?? []).length).toBe(15 + 15);
    expect(context.stroke).toHaveBeenCalled();
  });

  it('skips the grid while the zoom is too small for it to mean anything', () => {
    const { context } = recorder();
    const stage = new CharacterStage(context, source());

    stage.setModel(model({ chrome: chrome({ showGrid: true }) }));
    stage.draw();

    // zoom 3 < GRID_ZOOM.
    expect(context.stroke).not.toHaveBeenCalled();
  });

  it('runs a bone from the parent joint to the child and marks every anchor', () => {
    const { context, calls } = recorder();
    const stage = new CharacterStage(context, source());
    const authored: CharacterLayer[] = [
      { id: 'body', anchors: [{ id: 'neck', at: [8, 4] }], variants: [] },
      { id: 'head', parent: 'body', parentAnchor: 'neck', variants: [] },
    ];
    const resolved = character({
      layers: [
        layer({ layer: 'body', rect: [0, 0, 16, 16], origin: [0, 0] }),
        layer({ layer: 'head', rect: [8, 0, 8, 8], origin: [8, 4] }),
      ],
    });

    stage.setModel(
      model({ character: resolved, layers: authored, chrome: chrome({ showSkeleton: true }) }),
    );
    stage.draw();

    // One bone (head → body's neck); one joint dot (body's single anchor).
    expect(context.stroke).toHaveBeenCalledTimes(1);
    expect((calls['arc'] ?? []).length).toBe(1);
    expect(context.fill).toHaveBeenCalledTimes(1);
  });

  it('reflects the overlays for a mirrored character', () => {
    const { context } = recorder();
    const stage = new CharacterStage(context, source());

    stage.setModel(
      model({ character: character({ mirrored: true }), chrome: chrome({ canvasBounds: true }) }),
    );
    stage.draw();

    // placement originX 4, canvas 64 wide at zoom 3.
    expect(context.translate).toHaveBeenCalledWith(4 * 2 + 64 * 3, 0);
    expect(context.scale).toHaveBeenCalledWith(-1, 1);
  });
});

describe('CharacterStage pointer mapping', () => {
  it('turns a client point into the canvas pixel under it', () => {
    const { context } = recorder();
    const stage = new CharacterStage(context, source());
    stage.setModel(model());
    stage.draw();

    // Middle of canvas pixel (10, 20): 4 + 10*3 .. and 16 + 20*3 ..
    expect(stage.pixelAt(35.5, 77.5)).toEqual({ x: 10, y: 20 });
  });

  it('un-mirrors the canvas pixel when the character is drawn flipped', () => {
    const { context } = recorder();
    const stage = new CharacterStage(context, source());
    stage.setModel(model({ character: character({ mirrored: true }) }));
    stage.draw();

    expect(stage.pixelAt(35.5, 77.5)).toEqual({ x: 64 - 1 - 10, y: 20 });
  });

  it('measures a client point from the open layer box', () => {
    const { context } = recorder();
    const stage = new CharacterStage(context, source());
    const resolved = character({
      layers: [
        layer({ layer: 'body', rect: [0, 0, 64, 128] }),
        layer({ layer: 'head', rect: [8, 0, 8, 8] }),
      ],
    });

    stage.setModel(model({ character: resolved, chrome: chrome({ openLayerId: 'head' }) }));
    stage.draw();

    expect(stage.layerPixelAt(35.5, 77.5)).toEqual({ x: 10 - 8, y: 20 });
  });

  it('answers nothing for the open layer when no layer is open', () => {
    const { context } = recorder();
    const stage = new CharacterStage(context, source());
    stage.setModel(model());
    stage.draw();

    expect(stage.layerPixelAt(35.5, 77.5)).toBeNull();
  });
});

describe('paintedFor', () => {
  const tinted = character({
    layers: [
      layer({ layer: 'body', rect: [0, 0, 64, 128] }),
      layer({ layer: 'hair', rect: [8, 0, 16, 12], tint: '#c0ffee' }),
    ],
  });

  it('drops the tint of the layer being painted', () => {
    const shown = paintedFor(tinted, 'hair');
    expect(shown.layers.find((l) => l.layer === 'hair')?.tint).toBe('');
    // Every other layer is untouched.
    expect(shown.layers.find((l) => l.layer === 'body')).toBe(
      tinted.layers.find((l) => l.layer === 'body'),
    );
  });

  it('returns the character unchanged when the open layer has no tint', () => {
    expect(paintedFor(tinted, 'body')).toBe(tinted);
  });

  it('returns the character unchanged when no layer is open', () => {
    expect(paintedFor(tinted, null)).toBe(tinted);
  });
});

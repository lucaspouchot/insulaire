import { describe, expect, it } from 'vitest';

import { offset } from '../core/hex/hex-coords';
import { HexLayout } from '../core/hex/hex-layout';
import { Camera } from './camera';
import { HexMapRenderer } from './hex-map-renderer';
import { Projection } from './projection';
import { RenderModel, emptyRenderModel } from './render-model';

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
  const RAISED = offset(4, 6);
  const ELEVATION = 4;

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
    const renderer = new HexMapRenderer(
      {} as CanvasRenderingContext2D,
      new HexLayout(HEX_SIZE),
      new Camera(),
    );
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
    const projection = Projection.for('isometric', HEX_SIZE);

    for (let row = 0; row < flat.height; row += 1) {
      for (let col = 0; col < flat.width; col += 1) {
        const cell = offset(col, row);
        const screen = projection.project(renderer.layout.centerOf(cell));
        expect(renderer.cellAtScreen(screen)).toEqual(cell);
      }
    }
  });

  it('picks an elevated cell by its top face and by its side face', () => {
    const relief = model('isometric', true);
    const renderer = rendererFor(relief);
    const projection = Projection.for('isometric', HEX_SIZE);
    const center = renderer.layout.centerOf(RAISED);

    expect(renderer.cellAtScreen(projection.project(center, ELEVATION))).toEqual(RAISED);

    // Halfway down the cliff face: below the top face, above the cell's own row.
    const lift = projection.liftOf(ELEVATION);
    const bottom = projection.project({ x: center.x, y: center.y + HEX_SIZE }, ELEVATION);
    expect(renderer.cellAtScreen({ x: bottom.x, y: bottom.y + lift / 2 })).toEqual(RAISED);
  });

  it('gives the cell in front when an elevated tile covers the one behind', () => {
    const relief = model('isometric', true);
    const renderer = rendererFor(relief);
    const projection = Projection.for('isometric', HEX_SIZE);

    // Two rows back and column-aligned, so this point is the *centre* of a
    // perfectly ordinary cell — and yet the raised tile is drawn over it.
    const behind = offset(RAISED.col, RAISED.row - 2);
    const screen = projection.project(renderer.layout.centerOf(behind));

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
    const projection = Projection.for('isometric', HEX_SIZE);
    const center = renderer.layout.centerOf(above);

    // Halfway down the exposed face, on the front-right edge — right of the
    // bottom corner, where the cell in front no longer covers anything.
    const edge = projection.project({ x: center.x + HEX_SIZE * 0.4, y: center.y + HEX_SIZE * 0.8 });
    expect(renderer.cellAtScreen({ x: edge.x, y: edge.y + projection.liftOf(depth) / 2 })).toEqual(
      above,
    );
  });

  it('returns null outside the map', () => {
    const renderer = rendererFor(model('isometric', true));
    expect(renderer.cellAtScreen({ x: -500, y: -500 })).toBeNull();
    expect(renderer.cellAtScreen({ x: 5_000, y: 5_000 })).toBeNull();
  });
});

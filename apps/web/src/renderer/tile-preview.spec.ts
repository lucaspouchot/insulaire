import { describe, expect, it } from 'vitest';

import { TileArtGeometry, shoulderLine } from '../content/content-types';
import { HexLayout } from '../core/hex/hex-layout';
import {
  faceGuides,
  fitPreview,
  previewImageBox,
  previewPointOf,
  surfaceHexagon,
} from './tile-preview';

/**
 * The guides and the preview's framing, which are the two places the editor
 * could quietly stop agreeing with the renderer.
 *
 * A guide drawn by eye is worse than no guide: an artist would draw to it, and
 * the map would draw somewhere else
 * (`docs/adr/ADR-0035-tile-art-is-authored-and-resolved-by-level.md`).
 */
describe('tile preview geometry', () => {
  const GEOMETRY: TileArtGeometry = {
    width: 32,
    flatHeight: 37,
    surfaceHeight: 20,
    elevationHeight: 13,
    elevationStep: 8,
  };

  it('fits the hexagon exactly inside a surface image', () => {
    const hexagon = surfaceHexagon(GEOMETRY);

    const xs = hexagon.map((point) => point.x);
    const ys = hexagon.map((point) => point.y);
    expect(Math.min(...xs)).toBeCloseTo(0, 6);
    expect(Math.max(...xs)).toBeCloseTo(GEOMETRY.width, 6);
    expect(Math.min(...ys)).toBeCloseTo(0, 6);
    expect(Math.max(...ys)).toBeCloseTo(GEOMETRY.surfaceHeight, 6);
  });

  it('puts the pointy-top vertices where HexLayout puts them', () => {
    const hexagon = surfaceHexagon(GEOMETRY);
    const layout = new HexLayout(GEOMETRY.width / Math.sqrt(3));

    // Corner 5 is the top vertex and corner 2 the bottom one, which is the
    // ordering `addWallTo` extrudes from — the guides mark the same faces the
    // renderer draws.
    expect(hexagon[5]?.y).toBeCloseTo(0, 6);
    expect(hexagon[2]?.y).toBeCloseTo(GEOMETRY.surfaceHeight, 6);
    expect(hexagon[5]?.x).toBeCloseTo(GEOMETRY.width / 2, 6);
    expect(layout.hexWidth).toBeCloseTo(GEOMETRY.width, 6);
  });

  it('puts an elevation image on the hexagon lower shoulder line', () => {
    const hexagon = surfaceHexagon(GEOMETRY);
    const shoulders = [hexagon[1]?.y ?? 0, hexagon[3]?.y ?? 0];

    // Three quarters down, where the silhouette stops being full width — and
    // where an elevation image's own row 0 goes. A quarter down (the depth of
    // the `V`, which is the same number measured from the other end) hides the
    // faces behind the top face and leaves the drop empty.
    expect(Math.max(...shoulders)).toBeCloseTo(Math.min(...shoulders), 6);
    expect(shoulderLine(GEOMETRY)).toBeCloseTo(shoulders[0] ?? 0, 6);
  });

  it('marks the surface alone on a surface image', () => {
    expect(faceGuides(GEOMETRY, 'surface').map((guide) => guide.label)).toEqual(['surface']);
  });

  it('marks the two faces a pointy-top hexagon exposes, and no top face', () => {
    const guides = faceGuides(GEOMETRY, 'elevation');

    // Pointy-top: the silhouette has two lower edges meeting at the south
    // vertex, so there is a south-west face and a south-east face and no third.
    // No `surface` guide either — an elevation image holds no top face.
    expect(guides.map((guide) => guide.label)).toEqual(['southWest', 'southEast']);

    const ys = guides.flatMap((guide) => guide.path.map((point) => point.y));
    // The image's own space: row 0 is the lower shoulder line, and the faces
    // reach exactly the depth it reserves for them.
    expect(Math.min(...ys)).toBeCloseTo(0, 6);
    expect(Math.max(...ys)).toBeCloseTo(GEOMETRY.elevationHeight, 6);

    // They meet at the south vertex and never overlap.
    const west = guides[0]?.path ?? [];
    const east = guides[1]?.path ?? [];
    expect(Math.max(...west.map((point) => point.x))).toBeCloseTo(GEOMETRY.width / 2, 6);
    expect(Math.min(...east.map((point) => point.x))).toBeCloseTo(GEOMETRY.width / 2, 6);
  });

  it('frames a board inside the box it is given', () => {
    const cells = [0, 1, 2].map((col) => ({
      at: { col, row: 0 },
      tileId: 'grass',
      art: undefined,
      fallbackColor: '#000',
      elevation: 0,
    }));

    const view = fitPreview(cells, GEOMETRY, 300, 200);

    expect(view.layout.size).toBeGreaterThan(2);
    // Three hexes side by side have to fit across, padding included.
    expect(view.layout.hexWidth * 3).toBeLessThanOrEqual(300);
  });

  /**
   * The framing has no minimum worth the name: a dock dragged down to a sliver
   * gets a sliver of a board, not a board hanging out of its frame for the CSS
   * to clip (`docs/adr/ADR-0039-one-editor-for-everything-drawn.md`).
   */
  it('shrinks the board into a box far too short for it', () => {
    const cells = [0, 1, 2].map((col) => ({
      at: { col, row: 0 },
      tileId: 'dirt',
      art: undefined,
      fallbackColor: '#000',
      elevation: 3,
    }));

    const view = fitPreview(cells, GEOMETRY, 300, 40);

    expect(view.layout.size).toBeGreaterThan(0);
    // Whatever is left of the box after the padding, the stack fits in it.
    expect(view.layout.hexHeight).toBeLessThanOrEqual(40);
  });

  /**
   * A cell on the ground has no faces, so nothing hangs below its surface.
   * Framing for a cliff it does not have is a third of the box left empty, and
   * the box is where a tile is painted
   * (`docs/adr/ADR-0039-one-editor-for-everything-drawn.md`).
   */
  it('frames a cell on the ground to its surface, not to a cliff it has not got', () => {
    const flat = {
      at: { col: 0, row: 0 },
      tileId: 'dirt',
      art: undefined,
      fallbackColor: '#000',
      elevation: 0,
    };

    const view = fitPreview([flat], GEOMETRY, 300, 200);
    const raised = fitPreview([{ ...flat, elevation: 1 }], GEOMETRY, 300, 200);

    // The same box holds more of a flat cell than of a raised one.
    expect(view.layout.size).toBeGreaterThan(raised.layout.size);
  });

  it('frames the whole stack, not just its top face', () => {
    const cell = {
      at: { col: 0, row: 0 },
      tileId: 'dirt',
      art: undefined,
      fallbackColor: '#000',
      elevation: 0,
    };

    const flat = fitPreview([cell], GEOMETRY, 300, 200);
    const tall = fitPreview([{ ...cell, elevation: 6 }], GEOMETRY, 300, 200);

    // Six steps of cliff have to fit in the same box, so the hexes are smaller.
    expect(tall.layout.size).toBeLessThan(flat.layout.size);
  });

  it('survives a board with nothing on it', () => {
    const view = fitPreview([], GEOMETRY, 300, 200);

    expect(view.layout.size).toBeGreaterThan(0);
    expect(view.originX).toBe(0);
  });
});

/**
 * The arithmetic a click on the hexagon rests on.
 *
 * The preview is the drawing surface for a tile
 * (`docs/adr/ADR-0039-one-editor-for-everything-drawn.md`), so a pointer has to
 * come back as a pixel of the image under it — and the two frames involved, the
 * canvas and the hex plane the draw is translated into, are exactly where that
 * goes wrong.
 */
describe('painting on the preview', () => {
  const GEOMETRY: TileArtGeometry = {
    width: 32,
    flatHeight: 37,
    surfaceHeight: 20,
    elevationHeight: 13,
    elevationStep: 8,
  };

  function cell(elevation = 0) {
    return {
      at: { col: 0, row: 0 },
      tileId: 'grass',
      art: undefined,
      fallbackColor: '#000',
      elevation,
    };
  }

  it('puts a click through the origin the draw is translated by', () => {
    const view = fitPreview([cell()], GEOMETRY, 300, 200);

    // A point at the canvas's own origin is *not* the plane's origin: the draw
    // translated, and a hit test that forgets it lands a whole board away.
    expect(previewPointOf({ x: view.originX, y: view.originY }, view)).toEqual({ x: 0, y: 0 });
  });

  it('maps the middle of the surface image back to the middle of the sprite', () => {
    const view = fitPreview([cell()], GEOMETRY, 300, 200);
    const box = previewImageBox(cell(), GEOMETRY, view, 'surface');

    // What the workspace does with a pointer, in one line: plane point → box
    // → pixel of a 32x20 image.
    const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const pixel = {
      x: Math.floor(((middle.x - box.x) / box.width) * GEOMETRY.width),
      y: Math.floor(((middle.y - box.y) / box.height) * GEOMETRY.surfaceHeight),
    };

    expect(pixel).toEqual({ x: 16, y: 10 });
  });

  it('drops a stacked face by one elevation step per level below the top', () => {
    const view = fitPreview([cell(3)], GEOMETRY, 300, 400);
    const top = previewImageBox(cell(3), GEOMETRY, view, 'elevation', 0);
    const under = previewImageBox(cell(3), GEOMETRY, view, 'elevation', 1);

    expect(under.y - top.y).toBeCloseTo(view.projection.elevationStep, 6);
    expect(under.x).toBe(top.x);
  });

  it('gives the flat image the hexagon’s own middle, not the tilted one', () => {
    const view = fitPreview([cell()], GEOMETRY, 300, 200, 'topDown');
    const box = previewImageBox(cell(), GEOMETRY, view, 'flat');

    // Centred on the cell: a flat tile is the whole hexagon and nothing else
    // (`docs/adr/ADR-0037-a-flat-map-is-drawn-from-flat-art.md`).
    const centre = view.projection.project(view.layout.centerOf({ col: 0, row: 0 }), 0);
    expect(box.y + box.height / 2).toBeCloseTo(centre.y, 6);
    expect(box.height).toBeCloseTo(GEOMETRY.flatHeight * (box.width / GEOMETRY.width), 6);
  });
});

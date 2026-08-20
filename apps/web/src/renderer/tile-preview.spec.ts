import { describe, expect, it } from 'vitest';

import { TileArtGeometry, shoulderLine } from '../content/content-types';
import { HexLayout } from '../core/hex/hex-layout';
import { faceGuides, fitPreview, surfaceHexagon } from './tile-preview';

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

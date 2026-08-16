import { describe, expect, it } from 'vitest';

import { offset } from './hex-coords';
import { HexLayout } from './hex-layout';

/**
 * Pixel maths lives only in TypeScript, so this is the only place it is
 * covered. The key property is the screen <-> world round trip: whatever the
 * camera does, clicking a hex must select that hex.
 */
describe('HexLayout', () => {
  const layout = new HexLayout(24);

  it('rejects a non-positive size rather than producing NaN geometry', () => {
    expect(() => new HexLayout(0)).toThrow(RangeError);
    expect(() => new HexLayout(-4)).toThrow(RangeError);
  });

  it('derives pointy-top dimensions from the circumradius', () => {
    expect(layout.hexWidth).toBeCloseTo(Math.sqrt(3) * 24, 10);
    expect(layout.hexHeight).toBeCloseTo(48, 10);
    expect(layout.rowStep).toBeCloseTo(36, 10);
  });

  it('maps a pixel back to the hex that contains it', () => {
    for (let row = 0; row < 12; row += 1) {
      for (let col = 0; col < 12; col += 1) {
        const cell = offset(col, row);
        expect(layout.cellAt(layout.centerOf(cell))).toEqual(cell);
      }
    }
  });

  it('still resolves points that are off-centre inside a hex', () => {
    const cell = offset(5, 7);
    const center = layout.centerOf(cell);
    // Well inside the inradius (sqrt(3)/2 * size ~= 20.8) in every direction.
    for (const [dx, dy] of [
      [0, 0],
      [8, 0],
      [-8, 0],
      [0, 10],
      [0, -10],
      [6, 6],
      [-6, -6],
    ]) {
      expect(layout.cellAt({ x: center.x + dx, y: center.y + dy })).toEqual(cell);
    }
  });

  it('places odd rows half a hex to the right', () => {
    const evenRow = layout.centerOf(offset(0, 0));
    const oddRow = layout.centerOf(offset(0, 1));
    expect(oddRow.x - evenRow.x).toBeCloseTo(layout.hexWidth / 2, 10);
    expect(oddRow.y - evenRow.y).toBeCloseTo(layout.rowStep, 10);
  });

  it('produces six corners at the circumradius, with a vertex straight up', () => {
    const center = layout.centerOf(offset(2, 3));
    const corners = layout.corners(center);
    expect(corners).toHaveLength(6);

    for (const corner of corners) {
      expect(Math.hypot(corner.x - center.x, corner.y - center.y)).toBeCloseTo(24, 10);
    }

    // Corner 3 sits at 150 degrees; the topmost corner is the one at -90.
    const top = corners.reduce((best, corner) => (corner.y < best.y ? corner : best));
    expect(top.x).toBeCloseTo(center.x, 10);
    expect(top.y).toBeCloseTo(center.y - 24, 10);
  });

  it('bounds a map tightly enough to frame it', () => {
    const bounds = layout.boundsOf(20, 20);
    for (const cell of [offset(0, 0), offset(19, 0), offset(0, 19), offset(19, 19)]) {
      const center = layout.centerOf(cell);
      expect(center.x).toBeGreaterThanOrEqual(bounds.minX);
      expect(center.x).toBeLessThanOrEqual(bounds.maxX);
      expect(center.y).toBeGreaterThanOrEqual(bounds.minY);
      expect(center.y).toBeLessThanOrEqual(bounds.maxY);
    }
  });

  it('culls to a window that still covers everything visible', () => {
    // A window around the centre of a 40x40 map should return far fewer than
    // 1600 cells, but must include every cell whose centre is inside it.
    const view = { minX: 300, minY: 300, maxX: 600, maxY: 600 };
    const range = layout.visibleRange(view, 40, 40);

    const cellCount = (range.maxCol - range.minCol + 1) * (range.maxRow - range.minRow + 1);
    expect(cellCount).toBeLessThan(200);

    for (let row = 0; row < 40; row += 1) {
      for (let col = 0; col < 40; col += 1) {
        const center = layout.centerOf(offset(col, row));
        const inside =
          center.x >= view.minX && center.x <= view.maxX && center.y >= view.minY && center.y <= view.maxY;
        if (inside) {
          expect(col).toBeGreaterThanOrEqual(range.minCol);
          expect(col).toBeLessThanOrEqual(range.maxCol);
          expect(row).toBeGreaterThanOrEqual(range.minRow);
          expect(row).toBeLessThanOrEqual(range.maxRow);
        }
      }
    }
  });

  it('clamps the culling range to the map', () => {
    const range = layout.visibleRange({ minX: -9999, minY: -9999, maxX: 9999, maxY: 9999 }, 20, 20);
    expect(range).toEqual({ minCol: 0, maxCol: 19, minRow: 0, maxRow: 19 });
  });
});

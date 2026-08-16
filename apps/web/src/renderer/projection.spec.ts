import { describe, expect, it } from 'vitest';

import { offset } from '../core/hex/hex-coords';
import { HexLayout } from '../core/hex/hex-layout';
import { ISOMETRIC_TILT, Projection, toProjectionMode } from './projection';

/**
 * The projection is the only place the hex plane and the drawing plane differ,
 * so the properties the renderer relies on are asserted here: it inverts
 * exactly, it never moves `x`, and the rectangle it culls with covers
 * everything that can be on screen.
 */
describe('Projection', () => {
  const layout = new HexLayout(24);
  const isometric = Projection.for('isometric', layout.size);
  const topDown = Projection.for('topDown', layout.size);

  it('reads an unknown mode as top-down rather than throwing', () => {
    expect(toProjectionMode('isometric')).toBe('isometric');
    expect(toProjectionMode('topDown')).toBe('topDown');
    expect(toProjectionMode('cavalier')).toBe('topDown');
    expect(toProjectionMode(undefined)).toBe('topDown');
  });

  it('leaves the plane untouched in top-down mode', () => {
    expect(topDown.isIdentity).toBe(true);
    const point = { x: 137, y: -42 };
    expect(topDown.project(point, 5)).toEqual(point);
    expect(topDown.unproject(point, 5)).toEqual(point);
  });

  it('foreshortens the vertical axis and lifts elevated cells', () => {
    expect(isometric.isIdentity).toBe(false);
    expect(isometric.project({ x: 10, y: 100 }).y).toBeCloseTo(100 * ISOMETRIC_TILT, 10);
    // Raising a cell moves it up the screen, which is -y.
    expect(isometric.project({ x: 10, y: 100 }, 3).y).toBeLessThan(
      isometric.project({ x: 10, y: 100 }, 0).y,
    );
    expect(isometric.project({ x: 10, y: 100 }, 3).x).toBe(10);
  });

  it('inverts exactly, which is what keeps hit-testing accurate', () => {
    for (const elevation of [-7, 0, 1, 12]) {
      for (const point of [
        { x: 0, y: 0 },
        { x: 512, y: 331 },
        { x: -74, y: -900 },
      ]) {
        const round = isometric.unproject(isometric.project(point, elevation), elevation);
        expect(round.x).toBeCloseTo(point.x, 10);
        expect(round.y).toBeCloseTo(point.y, 10);
      }
    }
  });

  it('projects a whole map so that its highest and lowest cells still fit', () => {
    const plane = layout.boundsOf(20, 20);
    const bounds = isometric.projectRect(plane, -2, 6);

    expect(bounds.minX).toBe(plane.minX);
    expect(bounds.maxX).toBe(plane.maxX);
    // The top of the frame has to clear the tallest cell of the back row...
    expect(bounds.minY).toBeLessThan(plane.minY * ISOMETRIC_TILT);
    // ...and the bottom the deepest cell of the front row.
    expect(bounds.maxY).toBeGreaterThan(plane.maxY * ISOMETRIC_TILT);
  });

  it('culls with a plane rectangle that covers every cell the view can show', () => {
    const view = { minX: 0, minY: 0, maxX: 800, maxY: 600 };
    const plane = isometric.unprojectRect(view, -4, 9);

    // Every cell whose projected centre lands in the view must be inside the
    // plane rectangle, whatever its elevation. Missing one pops terrain at the
    // edge of the viewport.
    for (let row = 0; row < 60; row += 1) {
      for (const elevation of [-4, 0, 9]) {
        const center = layout.centerOf(offset(3, row));
        const projected = isometric.project(center, elevation);
        if (projected.y >= view.minY && projected.y <= view.maxY) {
          expect(center.y).toBeGreaterThanOrEqual(plane.minY);
          expect(center.y).toBeLessThanOrEqual(plane.maxY);
        }
      }
    }
  });
});

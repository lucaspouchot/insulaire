/**
 * A 2D pan/zoom camera.
 *
 * World space is what {@link HexLayout} produces; screen space is CSS pixels
 * inside the canvas element. The transform is
 *
 * ```text
 *   screen = world * zoom + pan
 *   world  = (screen - pan) / zoom
 * ```
 */

import { Point, Rect } from '../core/hex/hex-layout';

/** Lower and upper zoom bounds. */
export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 6;

export class Camera {
  private panX = 0;
  private panY = 0;
  private scale = 1;

  /** Current zoom factor. */
  get zoom(): number {
    return this.scale;
  }

  /** Current pan offset in screen pixels. */
  get pan(): Point {
    return { x: this.panX, y: this.panY };
  }

  /** Converts a world-space point to screen space. */
  toScreen(point: Point): Point {
    return { x: point.x * this.scale + this.panX, y: point.y * this.scale + this.panY };
  }

  /** Converts a screen-space point to world space. */
  toWorld(point: Point): Point {
    return { x: (point.x - this.panX) / this.scale, y: (point.y - this.panY) / this.scale };
  }

  /** Moves the camera by a screen-space delta. */
  panBy(dx: number, dy: number): void {
    this.panX += dx;
    this.panY += dy;
  }

  /**
   * Multiplies the zoom by `factor`, keeping the world point currently under
   * `anchor` (a screen position, typically the cursor) in place.
   */
  zoomBy(factor: number, anchor: Point): void {
    const before = this.toWorld(anchor);
    this.scale = clamp(this.scale * factor, MIN_ZOOM, MAX_ZOOM);
    const after = this.toWorld(anchor);
    this.panX += (after.x - before.x) * this.scale;
    this.panY += (after.y - before.y) * this.scale;
  }

  /** Sets an absolute zoom, keeping `anchor` in place. */
  zoomTo(zoom: number, anchor: Point): void {
    const target = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    if (this.scale !== 0) {
      this.zoomBy(target / this.scale, anchor);
    }
  }

  /** Frames `bounds` inside a `viewportWidth x viewportHeight` canvas. */
  fit(bounds: Rect, viewportWidth: number, viewportHeight: number, padding = 24): void {
    const worldWidth = Math.max(1, bounds.maxX - bounds.minX);
    const worldHeight = Math.max(1, bounds.maxY - bounds.minY);
    const usableWidth = Math.max(1, viewportWidth - padding * 2);
    const usableHeight = Math.max(1, viewportHeight - padding * 2);

    this.scale = clamp(Math.min(usableWidth / worldWidth, usableHeight / worldHeight), MIN_ZOOM, MAX_ZOOM);
    this.panX = viewportWidth / 2 - ((bounds.minX + bounds.maxX) / 2) * this.scale;
    this.panY = viewportHeight / 2 - ((bounds.minY + bounds.maxY) / 2) * this.scale;
  }

  /** The world-space rectangle currently visible in the viewport. */
  visibleWorldRect(viewportWidth: number, viewportHeight: number): Rect {
    const topLeft = this.toWorld({ x: 0, y: 0 });
    const bottomRight = this.toWorld({ x: viewportWidth, y: viewportHeight });
    return {
      minX: topLeft.x,
      minY: topLeft.y,
      maxX: bottomRight.x,
      maxY: bottomRight.y,
    };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

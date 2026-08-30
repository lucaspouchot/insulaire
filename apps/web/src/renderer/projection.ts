/**
 * The transform from the hex plane to the drawing plane.
 *
 * {@link HexLayout} describes one thing only: a top-down, pointy-top hex plane
 * (`docs/adr/ADR-0011-hex-coordinate-model.md`). This module turns that plane
 * into what the canvas actually receives, and it is the *only* place the two
 * differ (`docs/adr/ADR-0013-isometric-projection.md`).
 *
 * # The transform
 *
 * ```text
 *   x' = x
 *   y' = y * tilt - z * elevationStep       z = the cell's authored elevation
 * ```
 *
 * It is diagonal, which is the whole point:
 *
 * * it inverts exactly, so hit-testing stays pixel-accurate at any zoom;
 * * it maps axis-aligned rectangles to axis-aligned rectangles, so viewport
 *   culling needs no new geometry;
 * * it leaves `x` alone, so odd-r rows stay horizontal and a row remains a
 *   depth layer — back-to-front is simply `row 0 → row height-1`.
 *
 * A rotated axonometric basis would give up all three. See the ADR.
 */

import { Point, Rect } from '../core/hex/hex-layout';

/** How a world is projected onto the canvas; mirrors the engine's enum. */
export type ProjectionMode = 'topDown' | 'isometric';

/** Vertical foreshortening applied in isometric mode. */
export const ISOMETRIC_TILT = 0.55;

/** Pixels a cell rises per elevation step, as a fraction of the hex size. */
export const ISOMETRIC_ELEVATION_RATIO = 0.15;

/** `true` when `value` is one of the modes this renderer understands. */
export function isProjectionMode(value: unknown): value is ProjectionMode {
  return value === 'topDown' || value === 'isometric';
}

/** Reads a projection mode from untrusted content, falling back to top-down. */
export function toProjectionMode(value: unknown): ProjectionMode {
  return isProjectionMode(value) ? value : 'topDown';
}

export class Projection {
  private constructor(
    readonly mode: ProjectionMode,
    /** Vertical scale; `1` leaves the plane untouched. */
    readonly tilt: number,
    /** World pixels a cell rises per elevation step. */
    readonly elevationStep: number,
  ) {}

  /** The projection a `mode` implies for hexagons of circumradius `hexSize`. */
  static for(mode: ProjectionMode, hexSize: number): Projection {
    return Projection.from(mode, hexSize, ISOMETRIC_TILT, ISOMETRIC_ELEVATION_RATIO);
  }

  /**
   * The same, with the tilt and the step a tile set's authored art implies.
   *
   * A set that ships pixel art is the authority on what a hex looks like: its
   * surface image *is* the top face and its step *is* one level of relief. So
   * the projection is derived from the art rather than the art squashed into
   * the projection, and a sprite tile and a colour-filled tile cannot disagree
   * on the same map (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`).
   *
   * Everything downstream — hit-testing, culling, wall bases — keeps working by
   * construction, because it all still asks this object.
   */
  static from(
    mode: ProjectionMode,
    hexSize: number,
    tilt: number,
    elevationRatio: number,
  ): Projection {
    return mode === 'isometric'
      ? new Projection(mode, tilt, elevationRatio * hexSize)
      : new Projection(mode, 1, 0);
  }

  /**
   * `true` when the transform is the identity.
   *
   * The renderer keeps its single-batch path for this case, so a top-down world
   * costs exactly what it cost before the projection existed.
   */
  get isIdentity(): boolean {
    return this.tilt === 1 && this.elevationStep === 0;
  }

  /** How far above its row an elevation lifts a cell, in drawing pixels. */
  liftOf(elevation: number): number {
    return elevation * this.elevationStep;
  }

  /** Hex plane → drawing plane. */
  project(point: Point, elevation = 0): Point {
    return { x: point.x, y: point.y * this.tilt - this.liftOf(elevation) };
  }

  /** Drawing plane → hex plane, exactly inverting {@link project}. */
  unproject(point: Point, elevation = 0): Point {
    return { x: point.x, y: (point.y + this.liftOf(elevation)) / this.tilt };
  }

  /**
   * The drawing-plane rectangle covering `rect` for elevations in
   * `[minElevation, maxElevation]`.
   *
   * Used to frame a whole map: the highest cells stick out of the top of the
   * plain projection, and the lowest out of the bottom.
   */
  projectRect(rect: Rect, minElevation = 0, maxElevation = 0): Rect {
    return {
      minX: rect.minX,
      maxX: rect.maxX,
      minY: rect.minY * this.tilt - this.liftOf(maxElevation),
      maxY: rect.maxY * this.tilt - this.liftOf(minElevation),
    };
  }

  /**
   * The hex-plane rectangle that can appear inside the drawing-plane `rect`.
   *
   * The inverse of {@link projectRect}: a cell raised by `maxElevation` is drawn
   * above where its row sits, so cells from *further back* than the plain
   * inverse suggests can still be on screen — and the mirror holds for cells
   * pushed down. Culling with anything narrower pops terrain in and out at the
   * edges of the viewport.
   */
  unprojectRect(rect: Rect, minElevation = 0, maxElevation = 0): Rect {
    return {
      minX: rect.minX,
      maxX: rect.maxX,
      minY: (rect.minY + this.liftOf(minElevation)) / this.tilt,
      maxY: (rect.maxY + this.liftOf(maxElevation)) / this.tilt,
    };
  }
}

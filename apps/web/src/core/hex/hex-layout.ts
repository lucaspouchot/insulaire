/**
 * Pointy-top hex layout: the hex <-> pixel half of the coordinate model.
 *
 * This lives in TypeScript rather than in the engine on purpose. Pixel maths
 * depends on camera, zoom and device pixel ratio, it runs every frame, and the
 * engine must stay free of presentation concerns
 * (`docs/adr/ADR-0014-hex-coordinate-model.md`).
 *
 * # Geometry
 *
 * `size` is the circumradius — centre to corner, which for a regular hexagon is
 * also the edge length. For pointy-top hexagons:
 *
 * ```text
 *   width       = sqrt(3) * size
 *   height      = 2 * size
 *   column step = sqrt(3) * size          (horizontal neighbour)
 *   row step    = 1.5 * size              (vertical neighbour, rows overlap)
 * ```
 */

import { Axial, Offset, axialToOffset, offsetToAxial, roundAxial } from './hex-coords';

const SQRT3 = Math.sqrt(3);

/** A point in world space (pixels before the camera transform). */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** An axis-aligned world-space rectangle. */
export interface Rect {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** Converts between hex coordinates and world-space pixels. */
export class HexLayout {
  /**
   * @param size Circumradius of one hexagon in world pixels.
   */
  constructor(readonly size: number) {
    if (!(size > 0)) {
      throw new RangeError(`hex size must be positive, got ${size}`);
    }
  }

  /** Full width of one hexagon. */
  get hexWidth(): number {
    return SQRT3 * this.size;
  }

  /** Full height of one hexagon. */
  get hexHeight(): number {
    return 2 * this.size;
  }

  /** Vertical distance between two stacked rows. */
  get rowStep(): number {
    return 1.5 * this.size;
  }

  /** World-space centre of an axial coordinate. */
  centerOfAxial(hex: Axial): Point {
    return {
      x: this.size * SQRT3 * (hex.q + hex.r / 2),
      y: this.size * 1.5 * hex.r,
    };
  }

  /** World-space centre of an offset coordinate. */
  centerOf(cell: Offset): Point {
    return this.centerOfAxial(offsetToAxial(cell));
  }

  /** The hex containing a world-space point. */
  axialAt(point: Point): Axial {
    const q = ((SQRT3 / 3) * point.x - (1 / 3) * point.y) / this.size;
    const r = ((2 / 3) * point.y) / this.size;
    return roundAxial({ q, r });
  }

  /** The offset coordinate containing a world-space point. */
  cellAt(point: Point): Offset {
    return axialToOffset(this.axialAt(point));
  }

  /**
   * The six corners of a hexagon centred on `center`.
   *
   * Corner `i` sits at `60 * i - 30` degrees, which puts a vertex straight up —
   * the defining property of a pointy-top hexagon.
   */
  corners(center: Point): Point[] {
    const points: Point[] = [];
    for (let i = 0; i < 6; i += 1) {
      const angle = (Math.PI / 180) * (60 * i - 30);
      points.push({
        x: center.x + this.size * Math.cos(angle),
        y: center.y + this.size * Math.sin(angle),
      });
    }
    return points;
  }

  /** World-space bounds of a whole `width x height` map, including hex edges. */
  boundsOf(width: number, height: number): Rect {
    // The widest row is an odd one, which is shifted half a hex to the right.
    const halfWidth = this.hexWidth / 2;
    const lastRowShift = height > 1 ? halfWidth : 0;
    return {
      minX: -halfWidth,
      minY: -this.size,
      maxX: this.hexWidth * width + lastRowShift - halfWidth,
      maxY: this.rowStep * (height - 1) + this.size,
    };
  }

  /**
   * The inclusive range of offset cells that can overlap `view`.
   *
   * Used for viewport culling: the renderer only ever touches the cells this
   * returns, so drawing cost follows the visible area rather than the map size.
   * The range is padded by one cell because a hex's centre may sit just outside
   * the rectangle while part of the hex is still visible.
   */
  visibleRange(view: Rect, width: number, height: number): {
    minCol: number;
    maxCol: number;
    minRow: number;
    maxRow: number;
  } {
    const corners: Point[] = [
      { x: view.minX, y: view.minY },
      { x: view.maxX, y: view.minY },
      { x: view.minX, y: view.maxY },
      { x: view.maxX, y: view.maxY },
    ];

    let minCol = Number.POSITIVE_INFINITY;
    let maxCol = Number.NEGATIVE_INFINITY;
    let minRow = Number.POSITIVE_INFINITY;
    let maxRow = Number.NEGATIVE_INFINITY;

    for (const corner of corners) {
      const cell = this.cellAt(corner);
      minCol = Math.min(minCol, cell.col);
      maxCol = Math.max(maxCol, cell.col);
      minRow = Math.min(minRow, cell.row);
      maxRow = Math.max(maxRow, cell.row);
    }

    return {
      minCol: Math.max(0, minCol - 1),
      maxCol: Math.min(width - 1, maxCol + 1),
      minRow: Math.max(0, minRow - 1),
      maxRow: Math.min(height - 1, maxRow + 1),
    };
  }
}

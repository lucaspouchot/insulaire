/**
 * Hex coordinate transforms, mirroring `crates/world/src/hex.rs`.
 *
 * # What lives here and what does not
 *
 * This module contains **coordinate transforms only** — offset <-> axial, bounds
 * and row-major indexing. Those are geometry, not game rules, and the renderer
 * needs them every frame.
 *
 * Anything that decides what the player *may do* stays in Rust. The UI never
 * computes "is this hex adjacent, passable, free?"; it asks the engine and
 * highlights `legalMoves` from the snapshot. See
 * `docs/adr/ADR-0014-hex-coordinate-model.md`.
 *
 * # Representation
 *
 * Authored content and the engine boundary both speak **odd-r offset**
 * coordinates `[col, row]`: pointy-top hexagons, rows running horizontally,
 * odd rows shifted half a hex to the right. Axial `(q, r)` is the internal
 * form used for distance and pixel maths.
 */

/** An odd-r offset coordinate, the authored and boundary representation. */
export interface Offset {
  readonly col: number;
  readonly row: number;
}

/** An axial coordinate; the implicit cube axis is `s = -q - r`. */
export interface Axial {
  readonly q: number;
  readonly r: number;
}

/** The six axial directions of the pointy-top grid. */
export type HexDirection = 'east' | 'northEast' | 'northWest' | 'west' | 'southWest' | 'southEast';

/** Creates an offset coordinate. */
export function offset(col: number, row: number): Offset {
  return { col, row };
}

/** Creates an axial coordinate. */
export function axial(q: number, r: number): Axial {
  return { q, r };
}

/** `true` when two offset coordinates denote the same hex. */
export function sameOffset(a: Offset | null, b: Offset | null): boolean {
  return a !== null && b !== null && a.col === b.col && a.row === b.row;
}

/** Serialises an offset coordinate to the `[col, row]` wire form. */
export function toWire(value: Offset): [number, number] {
  return [value.col, value.row];
}

/** Reads an offset coordinate from the `[col, row]` wire form. */
export function fromWire(value: readonly [number, number]): Offset {
  return { col: value[0], row: value[1] };
}

/**
 * Euclidean modulo. JavaScript's `%` keeps the sign of the dividend, which
 * would break the offset conversion for negative rows.
 */
function mod2(value: number): number {
  return ((value % 2) + 2) % 2;
}

/** Converts odd-r offset coordinates to axial. */
export function offsetToAxial(value: Offset): Axial {
  // `row - (row mod 2)` is always even, so the halving is exact.
  return { q: value.col - (value.row - mod2(value.row)) / 2, r: value.row };
}

/** Converts axial coordinates to odd-r offset. */
export function axialToOffset(value: Axial): Offset {
  return { col: value.q + (value.r - mod2(value.r)) / 2, row: value.r };
}

/** The adjacent offset coordinate in one axial direction. Geometry, not legality. */
export function offsetNeighbor(value: Offset, direction: HexDirection): Offset {
  const current = offsetToAxial(value);
  const [dq, dr] = AXIAL_DELTAS[direction];
  return axialToOffset({ q: current.q + dq, r: current.r + dr });
}

const AXIAL_DELTAS: Readonly<Record<HexDirection, readonly [number, number]>> = {
  east: [1, 0],
  northEast: [1, -1],
  northWest: [0, -1],
  west: [-1, 0],
  southWest: [-1, 1],
  southEast: [0, 1],
};

/** The implicit third cube axis. */
export function cubeS(value: Axial): number {
  return -value.q - value.r;
}

/**
 * Hex distance: the minimum number of steps between two hexes.
 *
 * This is a metric, not a rule. It is fine for HUD text ("2 hexes away"); it is
 * never the basis for deciding whether a move is allowed.
 */
export function hexDistance(a: Axial, b: Axial): number {
  return (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(cubeS(a) - cubeS(b))) / 2;
}

/**
 * The rectangle a map's dense buffers cover; mirrors Rust's `MapBounds`.
 *
 * A map is a *set of hexes*, not a rectangle
 * (`docs/adr/ADR-0046-a-map-is-a-set-of-hexes.md`). This is only the box those
 * hexes are stored in, and the `origin` is what lets the box grow northwards or
 * westwards without renumbering a single authored cell — odd-r is not
 * translation-invariant, so a shape shifted by an odd number of rows would be a
 * different shape.
 */
export interface MapBounds {
  readonly origin: Offset;
  readonly width: number;
  readonly height: number;
}

/** Creates an extent; `origin` defaults to `[0, 0]`, where maps used to start. */
export function mapBounds(width: number, height: number, origin: Offset = ORIGIN): MapBounds {
  return { origin, width, height };
}

const ORIGIN: Offset = { col: 0, row: 0 };

/** An extent covering nothing, for a view with no world loaded. */
export const EMPTY_BOUNDS: MapBounds = mapBounds(0, 0);

/** Number of cells the extent covers, present or not. */
export function cellCount(bounds: MapBounds): number {
  return bounds.width * bounds.height;
}

/** First column covered. */
export function minCol(bounds: MapBounds): number {
  return bounds.origin.col;
}

/** First row covered. */
export function minRow(bounds: MapBounds): number {
  return bounds.origin.row;
}

/** Last column covered; meaningless on an empty extent. */
export function maxCol(bounds: MapBounds): number {
  return bounds.origin.col + bounds.width - 1;
}

/** Last row covered; meaningless on an empty extent. */
export function maxRow(bounds: MapBounds): number {
  return bounds.origin.row + bounds.height - 1;
}

/**
 * `true` when the coordinate has a slot in the buffers.
 *
 * This answers where a *buffer index* lives, never whether the map has that
 * hex — that is the presence buffer's answer, and only that one is a rule.
 */
export function isWithin(value: Offset, bounds: MapBounds): boolean {
  const col = value.col - bounds.origin.col;
  const row = value.row - bounds.origin.row;
  return col >= 0 && row >= 0 && col < bounds.width && row < bounds.height;
}

/** Row-major index of a cell, or `-1` when outside the extent. */
export function indexIn(value: Offset, bounds: MapBounds): number {
  return isWithin(value, bounds)
    ? (value.row - bounds.origin.row) * bounds.width + (value.col - bounds.origin.col)
    : -1;
}

/** The coordinate stored at a row-major index. */
export function fromIndex(index: number, bounds: MapBounds): Offset {
  const width = Math.max(1, bounds.width);
  return {
    col: bounds.origin.col + (index % width),
    row: bounds.origin.row + Math.floor(index / width),
  };
}

/** `true` when two extents cover exactly the same cells. */
export function sameBounds(a: MapBounds, b: MapBounds): boolean {
  return (
    a.width === b.width && a.height === b.height && a.origin.col === b.origin.col && a.origin.row === b.origin.row
  );
}

/**
 * Rounds fractional axial coordinates to the nearest hex.
 *
 * Rounds in cube space and repairs whichever axis moved furthest, which is the
 * standard construction that keeps `q + r + s == 0`.
 */
export function roundAxial(fractional: Axial): Axial {
  const fq = fractional.q;
  const fr = fractional.r;
  const fs = -fq - fr;

  let q = Math.round(fq);
  let r = Math.round(fr);
  const s = Math.round(fs);

  const dq = Math.abs(q - fq);
  const dr = Math.abs(r - fr);
  const ds = Math.abs(s - fs);

  if (dq > dr && dq > ds) {
    q = -r - s;
  } else if (dr > ds) {
    r = -q - s;
  }
  return { q, r };
}

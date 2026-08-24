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

/** `true` when the coordinate lies inside a `width x height` map. */
export function isWithin(value: Offset, width: number, height: number): boolean {
  return value.col >= 0 && value.row >= 0 && value.col < width && value.row < height;
}

/** Row-major index of a cell, or `-1` when out of bounds. */
export function indexIn(value: Offset, width: number, height: number): number {
  return isWithin(value, width, height) ? value.row * width + value.col : -1;
}

/** Rebuilds an offset coordinate from a row-major index. */
export function fromIndex(index: number, width: number): Offset {
  return { col: index % width, row: Math.floor(index / width) };
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

import { describe, expect, it } from 'vitest';

import {
  axial,
  axialToOffset,
  cubeS,
  cellCount,
  fromIndex,
  fromWire,
  hexDistance,
  indexIn,
  isWithin,
  mapBounds,
  offset,
  offsetNeighbor,
  offsetToAxial,
  roundAxial,
  sameOffset,
  toWire,
} from './hex-coords';

/**
 * These mirror the Rust tests in `crates/world/src/hex.rs`. Both sides of the
 * boundary must agree on what `[col, row]` means, so the same properties are
 * asserted twice on purpose.
 */
describe('hex coordinates', () => {
  it('keeps cube axes summing to zero', () => {
    for (let q = -5; q <= 5; q += 1) {
      for (let r = -5; r <= 5; r += 1) {
        expect(q + r + cubeS(axial(q, r))).toBe(0);
      }
    }
  });

  it('round-trips offset through axial, including negative rows', () => {
    for (let row = -8; row <= 8; row += 1) {
      for (let col = -8; col <= 8; col += 1) {
        const original = offset(col, row);
        expect(axialToOffset(offsetToAxial(original))).toEqual(original);
      }
    }
  });

  it('round-trips axial through offset', () => {
    for (let q = -8; q <= 8; q += 1) {
      for (let r = -8; r <= 8; r += 1) {
        const original = axial(q, r);
        expect(offsetToAxial(axialToOffset(original))).toEqual(original);
      }
    }
  });

  it('shifts odd rows to the right, matching odd-r layout', () => {
    // The same three assertions the Rust suite makes.
    expect(offsetToAxial(offset(0, 0))).toEqual(axial(0, 0));
    expect(offsetToAxial(offset(0, 1))).toEqual(axial(0, 1));
    expect(offsetToAxial(offset(0, 2))).toEqual(axial(-1, 2));
  });

  it('finds all six visual neighbours on even and odd rows', () => {
    expect([
      offsetNeighbor(offset(2, 2), 'northWest'),
      offsetNeighbor(offset(2, 2), 'northEast'),
      offsetNeighbor(offset(2, 2), 'west'),
      offsetNeighbor(offset(2, 2), 'east'),
      offsetNeighbor(offset(2, 2), 'southWest'),
      offsetNeighbor(offset(2, 2), 'southEast'),
    ]).toEqual([
      offset(1, 1),
      offset(2, 1),
      offset(1, 2),
      offset(3, 2),
      offset(1, 3),
      offset(2, 3),
    ]);
    expect(offsetNeighbor(offset(2, 3), 'northWest')).toEqual(offset(2, 2));
    expect(offsetNeighbor(offset(2, 3), 'northEast')).toEqual(offset(3, 2));
  });

  it('measures hex distance the same way the engine does', () => {
    const origin = axial(0, 0);
    expect(hexDistance(origin, axial(0, 0))).toBe(0);
    expect(hexDistance(origin, axial(1, 0))).toBe(1);
    expect(hexDistance(origin, axial(0, 1))).toBe(1);
    expect(hexDistance(origin, axial(2, 0))).toBe(2);
    expect(hexDistance(origin, axial(-2, 1))).toBe(2);
    expect(hexDistance(origin, axial(3, -1))).toBe(3);
  });

  it('is symmetric and obeys the triangle inequality', () => {
    const a = axial(0, 0);
    const b = axial(4, -2);
    const c = axial(-3, 5);
    expect(hexDistance(a, b)).toBe(hexDistance(b, a));
    expect(hexDistance(a, c)).toBeLessThanOrEqual(hexDistance(a, b) + hexDistance(b, c));
  });

  it('checks bounds inclusively from the extent\'s origin', () => {
    const bounds = mapBounds(20, 20);
    expect(isWithin(offset(0, 0), bounds)).toBe(true);
    expect(isWithin(offset(19, 19), bounds)).toBe(true);
    expect(isWithin(offset(20, 0), bounds)).toBe(false);
    expect(isWithin(offset(0, 20), bounds)).toBe(false);
    expect(isWithin(offset(-1, 0), bounds)).toBe(false);
    expect(isWithin(offset(0, -1), bounds)).toBe(false);
  });

  it('covers negative coordinates once the extent has an origin', () => {
    // A map extended northwards and westwards; mirrors the Rust assertions
    // (`docs/adr/ADR-0046-a-map-is-a-set-of-hexes.md`).
    const bounds = mapBounds(6, 8, offset(-3, -5));
    expect(isWithin(offset(-3, -5), bounds)).toBe(true);
    expect(isWithin(offset(2, 2), bounds)).toBe(true);
    expect(isWithin(offset(-4, -5), bounds)).toBe(false);
    expect(isWithin(offset(3, 2), bounds)).toBe(false);

    expect(indexIn(offset(-3, -5), bounds)).toBe(0);
    expect(indexIn(offset(-2, -5), bounds)).toBe(1);
    expect(indexIn(offset(-3, -4), bounds)).toBe(6);
  });

  it('round-trips row-major indices and rejects out-of-bounds cells', () => {
    const bounds = mapBounds(20, 12);
    expect(indexIn(offset(0, 0), bounds)).toBe(0);
    expect(indexIn(offset(19, 0), bounds)).toBe(19);
    expect(indexIn(offset(0, 1), bounds)).toBe(20);
    expect(indexIn(offset(20, 0), bounds)).toBe(-1);

    for (const extent of [bounds, mapBounds(20, 12, offset(-7, -3))]) {
      for (let index = 0; index < cellCount(extent); index += 1) {
        expect(indexIn(fromIndex(index, extent), extent)).toBe(index);
      }
    }
  });

  it('rounds fractional coordinates to a valid hex', () => {
    // Exactly on a centre.
    expect(roundAxial({ q: 2, r: -1 })).toEqual(axial(2, -1));
    // Just off a centre.
    expect(roundAxial({ q: 2.1, r: -0.95 })).toEqual(axial(2, -1));
    // Rounded results must still satisfy q + r + s == 0.
    const rounded = roundAxial({ q: 1.4, r: -0.7 });
    expect(rounded.q + rounded.r + cubeS(rounded)).toBe(0);
  });

  it('converts to and from the boundary wire form', () => {
    expect(toWire(offset(3, 4))).toEqual([3, 4]);
    expect(fromWire([3, 4])).toEqual(offset(3, 4));
  });

  it('compares cells, treating null as never equal', () => {
    expect(sameOffset(offset(1, 2), offset(1, 2))).toBe(true);
    expect(sameOffset(offset(1, 2), offset(2, 1))).toBe(false);
    expect(sameOffset(null, null)).toBe(false);
    expect(sameOffset(offset(1, 2), null)).toBe(false);
  });
});

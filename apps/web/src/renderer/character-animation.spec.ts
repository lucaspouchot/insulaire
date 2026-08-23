import { describe, expect, it } from 'vitest';

import { axialToOffset } from '../core/hex/hex-coords';
import { movementProgress, roleForMove } from './character-animation';

describe('roleForMove', () => {
  it('names all six axial directions across even and odd offset rows', () => {
    const origin = { q: 4, r: 4 };
    const from = axialToOffset(origin);
    const wire = (value: { col: number; row: number }): [number, number] => [value.col, value.row];
    const directions = [
      { delta: [1, 0], role: 'moveEast' },
      { delta: [1, -1], role: 'moveNorthEast' },
      { delta: [0, -1], role: 'moveNorthWest' },
      { delta: [-1, 0], role: 'moveWest' },
      { delta: [-1, 1], role: 'moveSouthWest' },
      { delta: [0, 1], role: 'moveSouthEast' },
    ] as const;

    for (const { delta, role } of directions) {
      const to = axialToOffset({ q: origin.q + delta[0], r: origin.r + delta[1] });
      expect(roleForMove(wire(from), wire(to))).toBe(role);
    }
  });
});

describe('movementProgress', () => {
  it('clamps a linear transition before, during and after its duration', () => {
    expect(movementProgress(100, 400, 0)).toBe(0);
    expect(movementProgress(100, 400, 300)).toBe(0.5);
    expect(movementProgress(100, 400, 500)).toBe(1);
    expect(movementProgress(100, 400, 900)).toBe(1);
  });

  it('finishes immediately when no positive duration is available', () => {
    expect(movementProgress(100, 0, 100)).toBe(1);
  });
});

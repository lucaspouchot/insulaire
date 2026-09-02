import { describe, expect, it } from 'vitest';

import { clampCoordinate, removeLink, setArrival, setName, setTarget } from './link-edits';
import type { DocumentLink } from '../../../../content/world-document';

function link(parts: Partial<DocumentLink> & { id: string }): DocumentLink {
  return {
    at: { col: 1, row: 1 },
    targetWorld: 'south',
    targetAt: { col: 0, row: 0 },
    name: '',
    tags: [],
    ...parts,
  };
}

const list: readonly DocumentLink[] = [
  link({ id: 'door_1', at: { col: 2, row: 2 } }),
  link({ id: 'door_2', at: { col: 4, row: 4 }, targetWorld: 'north', name: 'to the keep' }),
];

describe('clampCoordinate', () => {
  it('is a non-negative whole number, or zero when not finite', () => {
    expect(clampCoordinate(3.9)).toBe(3);
    expect(clampCoordinate(-2)).toBe(0);
    expect(clampCoordinate(Number.NaN)).toBe(0);
  });
});

describe('setTarget', () => {
  it('repoints the one door', () => {
    const next = setTarget(list, 'door_1', 'east');
    expect(next[0]?.targetWorld).toBe('east');
    expect(next[1]).toBe(list[1]);
  });
});

describe('setArrival', () => {
  it('writes a clamped arrival on the one door', () => {
    const next = setArrival(list, 'door_2', -5, 7.6);
    expect(next[1]?.targetAt).toEqual({ col: 0, row: 7 });
  });
});

describe('setName', () => {
  it('trims the name and leaves the rest alone', () => {
    const next = setName(list, 'door_1', '  gate  ');
    expect(next[0]?.name).toBe('gate');
    expect(next[1]).toBe(list[1]);
  });
});

describe('removeLink', () => {
  it('drops the one door', () => {
    expect(removeLink(list, 'door_1').map((entry) => entry.id)).toEqual(['door_2']);
  });
});

import { describe, expect, it } from 'vitest';

import {
  idAvailable,
  nudgePlacement,
  removePlacement,
  renamePlacement,
  resetOffset,
  setInteractive,
  setOffsetAxis,
} from './placement-edits';
import type { DocumentDecoration } from '../../../../content/world-document';

/** A placement with just the parts these rules read. */
function placement(parts: Partial<DocumentDecoration> & { id: string }): DocumentDecoration {
  return {
    decoration: 'tree',
    at: { col: 0, row: 0 },
    offset: [0, 0],
    interactive: false,
    tags: [],
    ...parts,
  };
}

const list: readonly DocumentDecoration[] = [
  placement({ id: 'tree_1', at: { col: 2, row: 3 } }),
  placement({ id: 'chest_1', at: { col: 2, row: 3 }, offset: [4, -2], interactive: true }),
  placement({ id: 'tree_2', at: { col: 5, row: 5 } }),
];

describe('idAvailable', () => {
  it('accepts a free, non-empty, changed name', () => {
    expect(idAvailable(list, 'chest_1', 'chest_with_the_letter')).toBe(true);
  });

  it('rejects an empty name, the current name, and one another placement holds', () => {
    expect(idAvailable(list, 'chest_1', '  ')).toBe(false);
    expect(idAvailable(list, 'chest_1', 'chest_1')).toBe(false);
    expect(idAvailable(list, 'chest_1', 'tree_2')).toBe(false);
  });
});

describe('renamePlacement', () => {
  it('renames the one placement and leaves the rest identical', () => {
    const next = renamePlacement(list, 'chest_1', 'chest_letter');
    expect(next.map((entry) => entry.id)).toEqual(['tree_1', 'chest_letter', 'tree_2']);
    expect(next[0]).toBe(list[0]);
    expect(next[2]).toBe(list[2]);
  });

  it('returns the list unchanged when the id is taken', () => {
    expect(renamePlacement(list, 'chest_1', 'tree_2')).toBe(list);
  });
});

describe('setInteractive', () => {
  it('flips the flag on one placement only', () => {
    const next = setInteractive(list, 'tree_1', true);
    expect(next[0]?.interactive).toBe(true);
    expect(next[1]).toBe(list[1]);
  });
});

describe('setOffsetAxis', () => {
  it('writes a rounded, clamped value on one axis', () => {
    const next = setOffsetAxis(list, 'tree_1', 0, 3.6);
    expect(next[0]?.offset).toEqual([4, 0]);
  });

  it('clamps past the cell bound', () => {
    const next = setOffsetAxis(list, 'tree_1', 1, 9999);
    expect(next[0]?.offset[1]).toBe(256);
  });

  it('ignores a value that is not a number', () => {
    expect(setOffsetAxis(list, 'tree_1', 0, Number.NaN)).toBe(list);
  });
});

describe('nudgePlacement', () => {
  it('moves by whole pixels and clamps', () => {
    const next = nudgePlacement(list, 'chest_1', -1, 3);
    expect(next[1]?.offset).toEqual([3, 1]);
  });
});

describe('resetOffset', () => {
  it('puts the placement back on its anchor', () => {
    const next = resetOffset(list, 'chest_1');
    expect(next[1]?.offset).toEqual([0, 0]);
  });
});

describe('removePlacement', () => {
  it('drops the one placement', () => {
    const next = removePlacement(list, 'chest_1');
    expect(next.map((entry) => entry.id)).toEqual(['tree_1', 'tree_2']);
  });
});

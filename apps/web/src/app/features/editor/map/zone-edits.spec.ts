import { describe, expect, it } from 'vitest';

import { addZone, canAddZone, canRemoveZone, removeZone, slugifyZone } from './zone-edits';
import type { ZoneDefinition } from '../../../../content/generated/project';

const zones: readonly ZoneDefinition[] = [
  { id: 'overworld', name: 'Overworld' },
  { id: 'caves', name: 'The Caves' },
];

describe('slugifyZone', () => {
  it('lowercases, collapses runs to one underscore, and trims them', () => {
    expect(slugifyZone('  The Deep Caves!! ')).toBe('the_deep_caves');
    expect(slugifyZone('***')).toBe('');
  });
});

describe('canAddZone', () => {
  it('accepts a non-empty, free slug', () => {
    expect(canAddZone(zones, 'ruins')).toBe(true);
  });

  it('rejects an empty slug or one already declared', () => {
    expect(canAddZone(zones, '')).toBe(false);
    expect(canAddZone(zones, 'caves')).toBe(false);
  });
});

describe('addZone', () => {
  it('appends the zone, falling back to the id for a blank name', () => {
    expect(addZone(zones, 'ruins', '  ')).toEqual([...zones, { id: 'ruins', name: 'ruins' }]);
  });

  it('returns the list unchanged when the slug is taken', () => {
    expect(addZone(zones, 'caves', 'Caves')).toBe(zones);
  });
});

describe('canRemoveZone', () => {
  it('needs the zone to exist, be empty, and not be the last', () => {
    expect(canRemoveZone(zones, 'caves', new Set(['overworld']))).toBe(true);
    expect(canRemoveZone(zones, 'caves', new Set(['overworld', 'caves']))).toBe(false);
    expect(canRemoveZone(zones, 'nowhere', new Set())).toBe(false);
    expect(canRemoveZone([{ id: 'only' }], 'only', new Set())).toBe(false);
  });
});

describe('removeZone', () => {
  it('drops an empty zone', () => {
    expect(removeZone(zones, 'caves', new Set(['overworld']))).toEqual([
      { id: 'overworld', name: 'Overworld' },
    ]);
  });

  it('returns the list unchanged when the zone still holds maps', () => {
    expect(removeZone(zones, 'caves', new Set(['caves']))).toBe(zones);
  });
});

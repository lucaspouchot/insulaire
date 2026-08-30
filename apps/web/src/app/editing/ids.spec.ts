import { describe, expect, it } from 'vitest';

import { freeId, slugId } from './ids';

/**
 * The two jobs that used to share the name `freeId`, kept apart on purpose
 * (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`).
 */
describe('freeId', () => {
  it('hands back the stem when nothing has taken it', () => {
    expect(freeId('object', [])).toBe('object');
    expect(freeId('object', ['potion'])).toBe('object');
  });

  it('counts up from two until it finds a free suffix', () => {
    expect(freeId('grass', ['grass'])).toBe('grass_2');
    expect(freeId('grass', ['grass', 'grass_2'])).toBe('grass_3');
    expect(freeId('grass', ['grass', 'grass_3'])).toBe('grass_2');
  });

  it('leaves the stem exactly as given, punctuation and capitals included', () => {
    expect(freeId('Mossy Rock', [])).toBe('Mossy Rock');
    expect(freeId('rock-2_copy', [])).toBe('rock-2_copy');
  });
});

describe('slugId', () => {
  it('slugifies a typed name before looking for a free one', () => {
    expect(slugId('Mossy Rock', [], 'tile')).toBe('mossy_rock');
    expect(slugId('  Deep Water  ', [], 'tile')).toBe('deep_water');
  });

  it('appends a suffix to the slug, not to the name', () => {
    expect(slugId('Mossy Rock', ['mossy_rock'], 'tile')).toBe('mossy_rock_2');
    expect(slugId('grass', ['grass', 'grass_2'], 'tile')).toBe('grass_3');
  });

  it('falls back when a name has no usable characters at all', () => {
    expect(slugId('!!!', [], 'tile')).toBe('tile');
    expect(slugId('', [], 'tile')).toBe('tile');
    expect(slugId('!!!', ['tile'], 'tile')).toBe('tile_2');
  });
});

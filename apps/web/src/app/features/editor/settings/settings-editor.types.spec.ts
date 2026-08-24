import { describe, expect, it } from 'vitest';

import { CONTROL_KINDS, SETTINGS_CONTROL_KINDS, defaultFor } from './settings-editor.types';

describe('settings editor control kinds', () => {
  it('offers key bindings to settings but not to character values', () => {
    expect(SETTINGS_CONTROL_KINDS).toContain('keyBinding');
    expect(CONTROL_KINDS).not.toContain('keyBinding');
    expect(defaultFor('keyBinding')).toBe('KeyQ');
  });
});

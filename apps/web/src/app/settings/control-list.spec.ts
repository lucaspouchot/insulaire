import { describe, expect, it } from 'vitest';

import {
  addOption,
  editOption,
  isNumeric,
  removeOption,
  setControlKind,
  usesOptions,
  type OptionListControl,
} from './control-list';
import type { ControlKind, SettingValue } from '../../content/generated/settings';

/** A settings-flavoured default policy, close to the real `defaultFor`. */
function defaultFor(kind: ControlKind, optionValues: readonly string[]): SettingValue {
  switch (kind) {
    case 'toggle':
    case 'checkbox':
      return false;
    case 'slider':
    case 'number':
      return 0;
    case 'color':
      return '#ffd166';
    case 'select':
      return optionValues[0] ?? '';
    case 'multiSelect':
      return [];
    case 'text':
      return '';
    case 'keyBinding':
      return 'KeyQ';
  }
}

describe('usesOptions / isNumeric', () => {
  it('names the option-bearing kinds', () => {
    expect(usesOptions('select')).toBe(true);
    expect(usesOptions('multiSelect')).toBe(true);
    expect(usesOptions('toggle')).toBe(false);
  });

  it('names the numeric kinds', () => {
    expect(isNumeric('slider')).toBe(true);
    expect(isNumeric('number')).toBe(true);
    expect(isNumeric('select')).toBe(false);
  });
});

describe('setControlKind', () => {
  it('resets the default to one the new kind accepts', () => {
    const next = setControlKind({ control: 'text', default: 'hi' }, 'toggle', defaultFor);
    expect(next).toEqual({ control: 'toggle', default: false });
  });

  it('feeds the current option values to the default policy', () => {
    const next = setControlKind(
      { control: 'text', default: '', options: [{ value: 'a', labelKey: 'a' }] },
      'select',
      defaultFor,
    );
    expect(next.default).toBe('a');
    expect(next.options).toEqual([{ value: 'a', labelKey: 'a' }]);
  });

  it('drops the options when the new kind does not choose from a list', () => {
    const next = setControlKind(
      { control: 'select', default: 'a', options: [{ value: 'a', labelKey: 'a' }] },
      'slider',
      defaultFor,
    );
    expect(next.options).toBeUndefined();
    expect(next.default).toBe(0);
  });

  it('clears the numeric bounds when the new kind is not numeric', () => {
    const next = setControlKind(
      { control: 'slider', default: 0, min: 0, max: 10, step: 1, unit: '%' },
      'text',
      defaultFor,
    );
    expect(next.min).toBeUndefined();
    expect(next.max).toBeUndefined();
    expect(next.step).toBeUndefined();
    expect(next.unit).toBeUndefined();
  });

  it('keeps the numeric bounds when moving between two numeric kinds', () => {
    const next = setControlKind(
      { control: 'slider', default: 0, min: 2, max: 8, step: 2, unit: 'px' },
      'number',
      defaultFor,
    );
    expect(next).toMatchObject({ min: 2, max: 8, step: 2, unit: 'px' });
  });

  it('normalises options to an array when moving to a list kind', () => {
    const control: OptionListControl = { control: 'text', default: '' };
    expect(setControlKind(control, 'select', defaultFor).options).toEqual([]);
  });

  it('keeps the options when moving between two list kinds', () => {
    const next = setControlKind(
      { control: 'select', default: 'a', options: [{ value: 'a', labelKey: 'a' }] },
      'multiSelect',
      defaultFor,
    );
    expect(next.options).toEqual([{ value: 'a', labelKey: 'a' }]);
    expect(next.default).toEqual([]);
  });

  it('does not mutate the input', () => {
    const control: OptionListControl = { control: 'text', default: 'hi' };
    setControlKind(control, 'toggle', defaultFor);
    expect(control).toEqual({ control: 'text', default: 'hi' });
  });
});

describe('addOption', () => {
  it('appends the option', () => {
    const next = addOption(
      { control: 'select', default: '', options: [{ value: 'a', labelKey: 'a' }] },
      { value: 'b', labelKey: 'b' },
    );
    expect(next.options).toEqual([
      { value: 'a', labelKey: 'a' },
      { value: 'b', labelKey: 'b' },
    ]);
  });

  it('makes the first option of an empty select its default', () => {
    const next = addOption({ control: 'select', default: '' }, { value: 'a', labelKey: 'a' });
    expect(next.default).toBe('a');
  });

  it('leaves the default alone once a select already has an option', () => {
    const next = addOption(
      { control: 'select', default: 'a', options: [{ value: 'a', labelKey: 'a' }] },
      { value: 'b', labelKey: 'b' },
    );
    expect(next.default).toBe('a');
  });

  it('does not touch the default for a multiSelect', () => {
    const next = addOption({ control: 'multiSelect', default: [] }, { value: 'a', labelKey: 'a' });
    expect(next.default).toEqual([]);
  });

  it('does not mutate the input', () => {
    const control: OptionListControl = { control: 'select', default: '' };
    addOption(control, { value: 'a', labelKey: 'a' });
    expect(control.options).toBeUndefined();
  });
});

describe('editOption', () => {
  it('renames the option value', () => {
    const next = editOption(
      { control: 'select', default: 'a', options: [{ value: 'a', labelKey: 'lbl' }] },
      0,
      { value: 'b' },
    );
    expect(next.options).toEqual([{ value: 'b', labelKey: 'lbl' }]);
  });

  it('relabels without touching the value or default', () => {
    const next = editOption(
      { control: 'select', default: 'a', options: [{ value: 'a', labelKey: 'lbl' }] },
      0,
      { labelKey: 'renamed' },
    );
    expect(next.options).toEqual([{ value: 'a', labelKey: 'renamed' }]);
    expect(next.default).toBe('a');
  });

  it('carries a matching default onto the new value', () => {
    const next = editOption(
      { control: 'select', default: 'a', options: [{ value: 'a', labelKey: 'a' }] },
      0,
      { value: 'b' },
    );
    expect(next.default).toBe('b');
  });

  it('leaves a default that names a different option', () => {
    const next = editOption(
      {
        control: 'select',
        default: 'b',
        options: [
          { value: 'a', labelKey: 'a' },
          { value: 'b', labelKey: 'b' },
        ],
      },
      0,
      { value: 'c' },
    );
    expect(next.default).toBe('b');
  });

  it('is a no-op for an index that is not there', () => {
    const control: OptionListControl = {
      control: 'select',
      default: 'a',
      options: [{ value: 'a', labelKey: 'a' }],
    };
    const next = editOption(control, 5, { value: 'z' });
    expect(next.options).toEqual([{ value: 'a', labelKey: 'a' }]);
  });
});

describe('removeOption', () => {
  it('drops the option at the index', () => {
    const next = removeOption(
      {
        control: 'select',
        default: 'a',
        options: [
          { value: 'a', labelKey: 'a' },
          { value: 'b', labelKey: 'b' },
        ],
      },
      0,
    );
    expect(next.options).toEqual([{ value: 'b', labelKey: 'b' }]);
  });

  it('moves a select default onto the first remaining option', () => {
    const next = removeOption(
      {
        control: 'select',
        default: 'a',
        options: [
          { value: 'a', labelKey: 'a' },
          { value: 'b', labelKey: 'b' },
        ],
      },
      0,
    );
    expect(next.default).toBe('b');
  });

  it('empties a select default when the last option goes', () => {
    const next = removeOption(
      { control: 'select', default: 'a', options: [{ value: 'a', labelKey: 'a' }] },
      0,
    );
    expect(next.default).toBe('');
  });

  it('drops the removed value out of a multiSelect default', () => {
    const next = removeOption(
      {
        control: 'multiSelect',
        default: ['a', 'b'],
        options: [
          { value: 'a', labelKey: 'a' },
          { value: 'b', labelKey: 'b' },
        ],
      },
      0,
    );
    expect(next.default).toEqual(['b']);
  });

  it('leaves a select default that names another option', () => {
    const next = removeOption(
      {
        control: 'select',
        default: 'b',
        options: [
          { value: 'a', labelKey: 'a' },
          { value: 'b', labelKey: 'b' },
        ],
      },
      0,
    );
    expect(next.default).toBe('b');
  });
});

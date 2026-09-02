import { describe, expect, it } from 'vitest';

import {
  addParameter,
  addParameterOption,
  defaultFor,
  editParameterOption,
  moveParameter,
  patchParameter,
  referencedKeys,
  removeParameter,
  removeParameterOption,
  setParameterControl,
} from './character-parameters';
import type { CharacterDefinition, CharacterLayer, ControlDefinition } from './character-editor.types';

/** A definition with just the parts these rules read. */
function doc(parts: {
  parameters?: ControlDefinition[];
  layers?: CharacterLayer[];
}): CharacterDefinition {
  return { id: 'hero', schemaVersion: 1, ...parts };
}

/** A layer whose one variant is tinted by `parameter` and gated on `when`. */
function tintedLayer(
  parameter: string,
  when: Record<string, string> = {},
): CharacterLayer {
  return {
    id: 'body',
    variants: [{ id: 'default', when, sprite: { asset: 'body.png', tint: { parameter } } }],
  };
}

describe('defaultFor', () => {
  it('picks the character editor colours and numbers', () => {
    expect(defaultFor('color')).toBe('#7a5c3e');
    expect(defaultFor('slider')).toBe(1);
    expect(defaultFor('number')).toBe(1);
    expect(defaultFor('toggle')).toBe(false);
    expect(defaultFor('text')).toBe('');
    expect(defaultFor('multiSelect')).toEqual([]);
  });

  it('is the first option value for a select, empty with none', () => {
    expect(defaultFor('select', ['warm', 'cool'])).toBe('warm');
    expect(defaultFor('select')).toBe('');
  });
});

describe('referencedKeys', () => {
  it('walks label, help and option keys in the validator order', () => {
    const document = doc({
      parameters: [
        {
          id: 'hair',
          labelKey: 'game.character.hair',
          helpKey: 'game.character.hair.help',
          control: 'select',
          default: 'brown',
          options: [
            { value: 'brown', labelKey: 'game.character.brown' },
            { value: 'black', labelKey: 'game.character.black' },
          ],
        },
        { id: 'tall', labelKey: 'game.character.tall', control: 'toggle', default: false },
      ],
    });
    expect(referencedKeys(document)).toEqual([
      'game.character.hair',
      'game.character.hair.help',
      'game.character.brown',
      'game.character.black',
      'game.character.tall',
    ]);
  });

  it('is empty for a definition that offers no parameters', () => {
    expect(referencedKeys(doc({}))).toEqual([]);
  });
});

describe('addParameter', () => {
  it('appends a blank select with its label key', () => {
    const document = doc({});
    addParameter(document);
    expect(document.parameters).toEqual([
      {
        id: 'parameter',
        labelKey: 'game.character.parameter',
        control: 'select',
        default: '',
        options: [],
      },
    ]);
  });

  it('gives the new parameter an id nothing else holds', () => {
    const document = doc({
      parameters: [
        { id: 'parameter', labelKey: 'k', control: 'toggle', default: false },
        { id: 'parameter_2', labelKey: 'k', control: 'toggle', default: false },
      ],
    });
    addParameter(document);
    expect(document.parameters?.at(-1)?.id).toBe('parameter_3');
  });
});

describe('removeParameter', () => {
  it('drops the parameter at the index', () => {
    const document = doc({
      parameters: [
        { id: 'a', labelKey: 'k', control: 'toggle', default: false },
        { id: 'b', labelKey: 'k', control: 'toggle', default: false },
      ],
    });
    removeParameter(document, 0);
    expect(document.parameters?.map((parameter) => parameter.id)).toEqual(['b']);
  });

  it('clears every tint bound to the removed parameter', () => {
    const document = doc({
      parameters: [{ id: 'hair', labelKey: 'k', control: 'color', default: '#000' }],
      layers: [tintedLayer('hair')],
    });
    removeParameter(document, 0);
    expect(document.layers?.[0].variants[0].sprite).toEqual({ asset: 'body.png' });
  });

  it('leaves a tint bound to a different parameter alone', () => {
    const document = doc({
      parameters: [
        { id: 'hair', labelKey: 'k', control: 'color', default: '#000' },
        { id: 'skin', labelKey: 'k', control: 'color', default: '#fff' },
      ],
      layers: [tintedLayer('skin')],
    });
    removeParameter(document, 0);
    expect(document.layers?.[0].variants[0].sprite.tint).toEqual({ parameter: 'skin' });
  });
});

describe('moveParameter', () => {
  it('reorders inside the list and stays inside it', () => {
    const document = doc({
      parameters: [
        { id: 'a', labelKey: 'k', control: 'toggle', default: false },
        { id: 'b', labelKey: 'k', control: 'toggle', default: false },
      ],
    });
    moveParameter(document, 0, 1);
    expect(document.parameters?.map((parameter) => parameter.id)).toEqual(['b', 'a']);
    moveParameter(document, 1, 1);
    expect(document.parameters?.map((parameter) => parameter.id)).toEqual(['b', 'a']);
  });
});

describe('patchParameter', () => {
  it('assigns the change onto the parameter', () => {
    const document = doc({
      parameters: [{ id: 'a', labelKey: 'k', control: 'slider', default: 1 }],
    });
    patchParameter(document, 0, { min: 0, max: 10 });
    expect(document.parameters?.[0]).toMatchObject({ min: 0, max: 10 });
  });

  it('is a no-op for an index that is not there', () => {
    const document = doc({ parameters: [] });
    expect(() => patchParameter(document, 3, { min: 0 })).not.toThrow();
  });
});

describe('setParameterControl', () => {
  it('switches the kind and replaces the default with one it accepts', () => {
    const document = doc({
      parameters: [
        {
          id: 'hair',
          labelKey: 'k',
          control: 'select',
          default: 'brown',
          options: [{ value: 'brown', labelKey: 'k' }],
        },
      ],
    });
    setParameterControl(document, 0, 'slider');
    expect(document.parameters?.[0]).toMatchObject({ control: 'slider', default: 1 });
    expect(document.parameters?.[0].options).toBeUndefined();
  });

  it('does nothing when the control is unchanged', () => {
    const parameter: ControlDefinition = { id: 'a', labelKey: 'k', control: 'toggle', default: true };
    const document = doc({ parameters: [parameter] });
    setParameterControl(document, 0, 'toggle');
    expect(document.parameters?.[0]).toBe(parameter);
  });
});

describe('addParameterOption', () => {
  it('appends an option with a free value and its label key', () => {
    const document = doc({
      parameters: [{ id: 'hair', labelKey: 'k', control: 'select', default: '', options: [] }],
    });
    addParameterOption(document, 0);
    expect(document.parameters?.[0].options).toEqual([
      { value: 'value', labelKey: 'game.character.value' },
    ]);
    expect(document.parameters?.[0].default).toBe('value');
  });

  it('does not collide with an existing option value', () => {
    const document = doc({
      parameters: [
        {
          id: 'hair',
          labelKey: 'k',
          control: 'select',
          default: 'value',
          options: [{ value: 'value', labelKey: 'k' }],
        },
      ],
    });
    addParameterOption(document, 0);
    expect(document.parameters?.[0].options?.at(-1)?.value).toBe('value_2');
  });
});

describe('editParameterOption', () => {
  it('renames the value and carries a matching default', () => {
    const document = doc({
      parameters: [
        {
          id: 'hair',
          labelKey: 'k',
          control: 'select',
          default: 'a',
          options: [{ value: 'a', labelKey: 'k' }],
        },
      ],
    });
    editParameterOption(document, 0, 0, { value: 'warm' });
    expect(document.parameters?.[0].options?.[0].value).toBe('warm');
    expect(document.parameters?.[0].default).toBe('warm');
  });

  it('carries every variant condition that named the old value', () => {
    const document = doc({
      parameters: [
        {
          id: 'hair',
          labelKey: 'k',
          control: 'select',
          default: 'a',
          options: [{ value: 'a', labelKey: 'k' }],
        },
      ],
      layers: [tintedLayer('hair', { hair: 'a' }), tintedLayer('hair', { hair: 'other' })],
    });
    editParameterOption(document, 0, 0, { value: 'warm' });
    expect(document.layers?.[0].variants[0].when).toEqual({ hair: 'warm' });
    expect(document.layers?.[1].variants[0].when).toEqual({ hair: 'other' });
  });

  it('leaves conditions alone for a pure relabel', () => {
    const document = doc({
      parameters: [
        {
          id: 'hair',
          labelKey: 'k',
          control: 'select',
          default: 'a',
          options: [{ value: 'a', labelKey: 'k' }],
        },
      ],
      layers: [tintedLayer('hair', { hair: 'a' })],
    });
    editParameterOption(document, 0, 0, { labelKey: 'game.character.warm' });
    expect(document.layers?.[0].variants[0].when).toEqual({ hair: 'a' });
  });
});

describe('removeParameterOption', () => {
  it('drops the option and moves a select default off it', () => {
    const document = doc({
      parameters: [
        {
          id: 'hair',
          labelKey: 'k',
          control: 'select',
          default: 'a',
          options: [
            { value: 'a', labelKey: 'k' },
            { value: 'b', labelKey: 'k' },
          ],
        },
      ],
    });
    removeParameterOption(document, 0, 0);
    expect(document.parameters?.[0].options).toEqual([{ value: 'b', labelKey: 'k' }]);
    expect(document.parameters?.[0].default).toBe('b');
  });

  it('is a no-op for a parameter index that is not there', () => {
    const document = doc({ parameters: [] });
    expect(() => removeParameterOption(document, 2, 0)).not.toThrow();
  });
});

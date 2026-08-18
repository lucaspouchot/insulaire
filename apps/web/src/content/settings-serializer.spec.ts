/**
 * The settings editor's export is the file that is checked in.
 *
 * Same contract as `world-serializer.spec.ts`: what the editor writes has to be
 * byte-identical to `content/settings.json`, or saving a file nobody edited
 * would produce a diff — and a diff nobody trusts is a diff nobody reads.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { SettingsDefinition } from './content-types';
import { serializeSettings } from './settings-serializer';

// Vitest runs with `apps/web` as its root, so the repository root is two levels up.
const repoRoot = resolve(process.cwd(), '../..');

describe('serializeSettings', () => {
  it('reproduces the shipped settings file byte for byte', () => {
    const text = readFileSync(resolve(repoRoot, 'content/settings.json'), 'utf8');
    const settings = JSON.parse(text) as SettingsDefinition;

    expect(serializeSettings(settings)).toBe(text);
  });

  it('omits what the engine would fill in anyway, and always states the scope', () => {
    const json = serializeSettings({
      id: 'game',
      schemaVersion: 1,
      sections: [
        {
          id: 's',
          labelKey: 'k.s',
          groups: [
            {
              id: 'g',
              labelKey: 'k.g',
              fields: [
                {
                  id: 'flag',
                  labelKey: 'k.flag',
                  helpKey: '',
                  control: 'toggle',
                  default: false,
                  options: [],
                  min: null,
                  max: null,
                  step: null,
                  unit: '',
                  showIf: null,
                },
              ],
            },
          ],
        },
      ],
    });

    expect(json).not.toContain('helpKey');
    expect(json).not.toContain('"min"');
    expect(json).not.toContain('options');
    expect(json).not.toContain('showIf');
    expect(json).toContain('"scope": "session"');
    expect(json.endsWith('\n')).toBe(true);
  });

  it('writes bounds, a unit, options and a condition when they carry something', () => {
    const settings: SettingsDefinition = {
      id: 'game',
      schemaVersion: 1,
      sections: [
        {
          id: 's',
          labelKey: 'k.s',
          groups: [
            {
              id: 'g',
              labelKey: 'k.g',
              fields: [
                {
                  id: 'size',
                  labelKey: 'k.size',
                  helpKey: 'k.sizeHelp',
                  control: 'slider',
                  default: 20,
                  min: 0,
                  max: 100,
                  step: 5,
                  unit: '%',
                  scope: 'newGame',
                },
                {
                  id: 'flavour',
                  labelKey: 'k.flavour',
                  control: 'select',
                  default: 'a',
                  scope: 'newGame',
                  options: [
                    { value: 'a', labelKey: 'k.a' },
                    { value: 'b', labelKey: 'k.b' },
                  ],
                  showIf: { field: 'size', equals: 20 },
                },
              ],
            },
          ],
        },
      ],
    };
    const json = serializeSettings(settings);

    expect(json).toContain('              "unit": "%",\n');
    expect(json).toContain('                { "value": "a", "labelKey": "k.a" },\n');
    expect(json).toContain('              "showIf": { "field": "size", "equals": 20 }\n');
    expect(JSON.parse(json)).toEqual(settings);
  });
});

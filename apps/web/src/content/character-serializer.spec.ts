import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { serializeCharacter } from './character-serializer';
import { CharacterDefinition } from './content-types';

// Vitest runs with `apps/web` as its root, so the repository root is two levels up.
const repoRoot = resolve(process.cwd(), '../..');

function readText(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

describe('serializeCharacter', () => {
  it('writes one variant per line', () => {
    const json = serializeCharacter({
      id: 'goblin',
      schemaVersion: 1,
      category: 'monster',
      resolution: { width: 32, height: 48 },
      parameters: [],
      layers: [
        {
          id: 'body',
          variants: [
            {
              id: 'default',
              rect: [4, 8, 24, 40],
              sprite: { asset: 'assets/characters/goblin.png' },
            },
          ],
        },
      ],
    });

    expect(json).toContain(
      '    { "id": "default", "rect": [4, 8, 24, 40], ' +
        '"sprite": { "asset": "assets/characters/goblin.png" } }\n',
    );
    expect(json.endsWith('\n')).toBe(true);
  });

  it('produces JSON that parses back to the same value', () => {
    const character: CharacterDefinition = {
      id: 'merchant',
      schemaVersion: 1,
      name: 'Merchant "quoted" \\ backslash',
      category: 'npc',
      resolution: { width: 48, height: 96 },
      parameters: [
        {
          id: 'size',
          labelKey: 'game.character.size',
          helpKey: 'game.character.sizeHelp',
          control: 'slider',
          default: 1,
          min: 0.5,
          max: 2,
          step: 0.1,
          unit: '×',
        },
        {
          id: 'clothes',
          labelKey: 'game.character.clothes',
          control: 'select',
          default: 'plain',
          options: [
            { value: 'plain', labelKey: 'game.character.plain' },
            { value: 'rich', labelKey: 'game.character.rich' },
          ],
          showIf: { field: 'size', equals: 1 },
        },
      ],
      layers: [
        {
          id: 'clothes',
          variants: [
            {
              id: 'rich',
              when: { clothes: 'rich' },
              rect: [4, 12, 40, 80],
              sprite: {
                asset: 'assets/characters/rich.png',
                tint: { parameter: 'clothes' },
              },
            },
            { id: 'plain', sprite: { asset: 'assets/characters/plain.png' } },
          ],
        },
      ],
    };

    const parsed = JSON.parse(serializeCharacter(character)) as CharacterDefinition;
    // The one difference is deliberate: a variant that authored no box gets the
    // empty one written out, which is what it already meant.
    expect(parsed.layers?.[0]?.variants?.[1]?.rect).toEqual([0, 0, 0, 0]);
    expect({
      ...parsed,
      layers: [
        {
          ...parsed.layers?.[0],
          variants: [
            parsed.layers?.[0]?.variants?.[0],
            { id: 'plain', sprite: { asset: 'assets/characters/plain.png' } },
          ],
        },
      ],
    }).toEqual(character);
  });

  it('omits what the engine would fill back in', () => {
    const json = serializeCharacter({
      id: 'skeleton',
      schemaVersion: 1,
      parameters: [],
      layers: [],
    });

    expect(json).not.toContain('"name"');
    expect(json).not.toContain('"tint"');
    // But never the two fields the file is about.
    expect(json).toContain('"category": "other"');
    expect(json).toContain('"resolution": { "width": 64, "height": 128 }');
  });

  /**
   * The same guarantee `world-serializer.spec.ts` gives for maps: what the
   * editor writes is byte for byte what is checked in, so saving a character
   * nobody touched produces no diff.
   */
  it('reproduces the shipped character byte for byte', () => {
    const path = 'content/characters/human_player.json';
    const shipped = JSON.parse(readText(path)) as CharacterDefinition;

    expect(serializeCharacter(shipped)).toBe(readText(path));
  });
});

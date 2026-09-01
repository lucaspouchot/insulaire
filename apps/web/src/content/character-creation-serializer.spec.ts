import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { serializeCharacterCreation } from './character-creation-serializer';
import { CharacterCreationDefinition } from './generated/character-creation';

const repoRoot = resolve(import.meta.dirname, '../../../..');

describe('serializeCharacterCreation', () => {
  it('round trips the generic workflow without a settings scope', () => {
    const definition: CharacterCreationDefinition = {
      id: 'new_game',
      schemaVersion: 1,
      baseCharacter: 'human_player',
      choices: [
        {
          id: 'hair',
          labelKey: 'game.creation.hair',
          control: 'select',
          default: 'short',
          scope: 'newGame',
          options: [{ value: 'short', labelKey: 'game.creation.hairShort' }],
          binding: { kind: 'parameter', parameter: 'hairStyle' },
        },
      ],
      characteristics: [],
      screens: [{ id: 'look', titleKey: 'game.creation.look', blocks: [] }],
    };

    const json = serializeCharacterCreation(definition);
    expect(json).not.toContain('"scope"');
    expect(JSON.parse(json)).toEqual({
      ...definition,
      choices: definition.choices?.map(({ scope: _scope, ...choice }) => choice),
    });
  });

  /**
   * The workflow the game ships is written by this module, so an exported file
   * diffs cleanly against the hand-edited one — the same guarantee every other
   * content kind has.
   */
  it('reproduces the shipped workflow byte for byte', () => {
    const path = resolve(repoRoot, 'content/character-creation.json');
    const original = readFileSync(path, 'utf8');

    expect(serializeCharacterCreation(JSON.parse(original) as CharacterCreationDefinition)).toBe(
      original,
    );
  });
});

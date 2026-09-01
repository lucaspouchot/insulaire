import { describe, expect, it } from 'vitest';

import { CharacterCreationDefinition } from './generated/character-creation';
import { serializeCharacterCreation } from './character-creation-serializer';

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
});

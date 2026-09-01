/**
 * Writes a {@link CharacterCreationDefinition} back out as a content file.
 *
 * This one used to be `JSON.stringify(_, null, 2)` with a replacer, which read
 * as a different *kind* of writer next to the other six and produced a file
 * where one two-key choice block took four lines. It is the same writer now,
 * with the same rules: a fixed field order, one record per line, and nothing
 * that says what leaving it out already says
 * (`docs/adr/ADR-0029-character-creation-is-a-generic-authored-workflow.md`).
 *
 * ```json
 * "blocks": [
 *   { "type": "choice", "choice": "lineage" },
 *   { "type": "characteristic", "characteristic": "name" }
 * ]
 * ```
 *
 * A choice and a characteristic are a **setting** plus what makes them one:
 * where the value lands, and whether it may be left empty. So both write the
 * settings table (`settings-serializer.ts`) with `scope` turned off — a
 * creation choice is answered once, and when a player may change a setting
 * means nothing to it.
 */

import { blockOf, canonicalJson, Fields, list, Shape, value } from './canonical-json';
import {
  CHARACTER_CREATION_ABSENT,
  CHARACTERISTIC_ABSENT,
  CharacterCreationDefinition,
  CharacteristicDefinition,
  CREATION_SCREEN_ABSENT,
  CreationChoice,
  CreationScreen,
} from './generated/character-creation';
import { CONTROL_ABSENT, ControlDefinition } from './generated/settings';
import { CONTROL_FIELDS } from './settings-serializer';

/**
 * The settings vocabulary as character creation reads it.
 *
 * `scope` is the one field the two disagree about: a creation choice is
 * answered once, so when a player may change it means nothing here.
 */
const ANSWERED_ONCE: Fields<ControlDefinition> = { ...CONTROL_FIELDS, scope: 'never' };

/** One choice: a setting, and the parameter its answer lands in. */
const CHOICE: Shape<CreationChoice> = {
  absent: CONTROL_ABSENT,
  fields: { ...ANSWERED_ONCE, binding: 'always' },
};

/** One characteristic: a setting the player writes, which may be left empty. */
const CHARACTERISTIC: Shape<CharacteristicDefinition> = {
  absent: { ...CONTROL_ABSENT, ...CHARACTERISTIC_ABSENT },
  fields: { ...ANSWERED_ONCE, nullable: 'unless-redundant' },
};

/** One screen: its heading, then one block per line. */
const SCREEN: Shape<CreationScreen> = {
  absent: CREATION_SCREEN_ABSENT,
  fields: {
    id: 'always',
    titleKey: 'always',
    textKey: 'unless-redundant',
    transition: 'unless-redundant',
    blocks: { write: 'always', as: (blocks) => list(blocks.map((block) => value(block))) },
  },
};

/** The workflow, field by field, in the order it states them. */
const CREATION: Shape<CharacterCreationDefinition> = {
  absent: CHARACTER_CREATION_ABSENT,
  fields: {
    id: 'always',
    schemaVersion: 'always',
    baseCharacter: 'unless-redundant',
    choices: { write: 'always', as: (choices) => list(choices.map((c) => blockOf(c, CHOICE))) },
    characteristics: {
      write: 'always',
      as: (characteristics) => list(characteristics.map((c) => blockOf(c, CHARACTERISTIC))),
    },
    screens: { write: 'always', as: (screens) => list(screens.map((s) => blockOf(s, SCREEN))) },
  },
};

/** The character-creation file, in the canonical layout. */
export function serializeCharacterCreation(definition: CharacterCreationDefinition): string {
  return canonicalJson(blockOf(definition, CREATION));
}

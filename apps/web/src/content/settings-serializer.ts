/**
 * Writes a {@link SettingsDefinition} back out as `content/settings.json`.
 *
 * `JSON.stringify(_, null, 2)` would work and would be unreadable: the engine
 * fills every optional field in before the editor ever sees a declaration, so a
 * naive round trip turns a six-line field into fifteen and puts `"min": null`
 * next to a toggle. A settings file is read and diffed by people, so this one
 * writes what an author would have written — fixed key order, one option per
 * line, and nothing that carries no information.
 *
 * The rule for omitting is the engine's own defaults, as `CONTROL_ABSENT`
 * publishes them from `crates/world/src/settings.rs`: an absent `helpKey`,
 * `unit`, `options`, `min`, `max`, `step` or `showIf` parses back to exactly the
 * value dropped here. `scope` is the exception and is always written — it
 * decides whether a player can move the setting during a game, which is worth
 * reading in the file rather than knowing (`docs/adr/ADR-0022-settings.md`).
 * See `canonical-json.ts` for the layout these tables are read by.
 */

import { blockOf, canonicalJson, Fields, list, rowOf, Shape } from './canonical-json';
import {
  CONTROL_ABSENT,
  ControlDefinition,
  ControlOption,
  SettingsDefinition,
  SettingsGroup,
  SettingsSection,
} from './generated/settings';

/** One choice of a select, on one line. */
const OPTION: Shape<ControlOption> = {
  fields: { value: 'always', labelKey: 'always' },
};

/**
 * One setting, in the order the file states it.
 *
 * Exported because a character parameter is the same vocabulary read by a
 * different screen — `character-serializer.ts` writes this table with `scope`
 * turned off, which is the only field the two disagree about
 * (`docs/adr/ADR-0024-character-definitions.md`).
 */
export const CONTROL_FIELDS: Fields<ControlDefinition> = {
  id: 'always',
  labelKey: 'always',
  helpKey: 'unless-redundant',
  control: 'always',
  default: 'always',
  min: 'unless-redundant',
  max: 'unless-redundant',
  step: 'unless-redundant',
  unit: 'unless-redundant',
  scope: 'always',
  // One option per line: a choice added is a line added.
  options: {
    write: 'unless-redundant',
    as: (options) => list(options.map((option) => rowOf(option, OPTION))),
  },
  showIf: 'unless-redundant',
};

/** What an absent field of a setting means, for anything that writes one. */
export const CONTROL: Shape<ControlDefinition> = {
  absent: CONTROL_ABSENT,
  fields: CONTROL_FIELDS,
};

const GROUP: Shape<SettingsGroup> = {
  fields: {
    id: 'always',
    labelKey: 'always',
    fields: { write: 'always', as: (fields) => list(fields.map((field) => blockOf(field, CONTROL))) },
  },
};

const SECTION: Shape<SettingsSection> = {
  fields: {
    id: 'always',
    labelKey: 'always',
    groups: { write: 'always', as: (groups) => list(groups.map((group) => blockOf(group, GROUP))) },
  },
};

const SETTINGS: Shape<SettingsDefinition> = {
  fields: {
    id: 'always',
    schemaVersion: 'always',
    sections: {
      write: 'always',
      as: (sections) => list(sections.map((section) => blockOf(section, SECTION))),
    },
  },
};

/** The settings file, in the canonical layout. */
export function serializeSettings(settings: SettingsDefinition): string {
  return canonicalJson(blockOf(settings, SETTINGS));
}

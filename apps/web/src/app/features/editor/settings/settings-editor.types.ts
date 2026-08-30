/**
 * The shapes the settings editor works with, and the small amount of knowledge
 * about the control vocabulary that authoring — as opposed to rendering — needs.
 *
 * The vocabulary itself is `crates/world/src/settings.rs`, mirrored in
 * `content-types.ts` and rendered by `app/settings/control-field`. What lives
 * here is only what a *form for building one* has to know: which control kinds
 * carry options, which carry bounds, and what a freshly added field should
 * default to so that it validates the moment it exists
 * (`docs/adr/ADR-0022-settings.md`).
 */

import { ControlKind, SettingScope, SettingValue } from '../../../../content/content-types';

export type {
  ControlDefinition,
  ControlKind,
  ControlOption,
  SettingScope,
  SettingValue,
  SettingsDefinition,
  SettingsGroup,
  SettingsSection,
  ShowIf,
} from '../../../../content/content-types';

/** Value controls that may also describe characters and creation answers. */
export const CONTROL_KINDS: readonly ControlKind[] = [
  'toggle',
  'checkbox',
  'select',
  'multiSelect',
  'slider',
  'number',
  'text',
  'color',
];

/** Every settings control kind, in the order the picker offers them. */
export const SETTINGS_CONTROL_KINDS: readonly ControlKind[] = [...CONTROL_KINDS, 'keyBinding'];

/** Every scope, in the order the picker offers them, with the label it shows. */
export const SCOPES: readonly { readonly id: SettingScope; readonly labelKey: string }[] = [
  { id: 'session', labelKey: 'ui.editor.settings.scopeSession' },
  { id: 'newGame', labelKey: 'ui.editor.settings.scopeNewGame' },
];

/** `true` when this control chooses from a declared list of options. */
export function usesOptions(control: ControlKind): boolean {
  return control === 'select' || control === 'multiSelect';
}

/** `true` when this control has `min`, `max` and `step`. */
export function isNumeric(control: ControlKind): boolean {
  return control === 'slider' || control === 'number';
}

/**
 * A default this control accepts, given the options it currently declares.
 *
 * Used when a field is created and when its control kind changes: the engine
 * refuses a declaration whose default its own control does not accept
 * (`settings.invalidDefault`), so the form never produces one in the first
 * place. It is a starting point, not a decision — the author sets the real
 * default in the preview.
 */
export function defaultFor(control: ControlKind, options: readonly string[] = []): SettingValue {
  switch (control) {
    case 'toggle':
    case 'checkbox':
      return false;
    case 'slider':
    case 'number':
      return 0;
    case 'color':
      return '#ffd166';
    case 'select':
      return options[0] ?? '';
    case 'multiSelect':
      return [];
    case 'text':
      return '';
    case 'keyBinding':
      return 'KeyQ';
  }
}

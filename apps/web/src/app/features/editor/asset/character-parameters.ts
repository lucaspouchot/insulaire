/**
 * The list-editing rules a *character definition's parameter list* needs, in
 * one place.
 *
 * A character parameter is a `ControlDefinition` (`crates/world/src/settings.rs`)
 * like a settings field or a character-creation choice, so the single-control
 * moves — switch the kind, add / edit / remove an option — are already owned by
 * `app/settings/control-list.ts` and this module calls them. What is left, and
 * what lives here, is everything that keeps the *whole* `CharacterDefinition`
 * valid the instant the list changes:
 *
 * - a new parameter carries its label key, and a fresh id nothing else holds;
 * - deleting a parameter drops every tint bound to it — a dangling
 *   `{ parameter }` colour source does not validate;
 * - renaming an option value carries every variant `when` that named it, rather
 *   than leaving a variant waiting on a value nobody offers.
 *
 * Each function takes the mutable draft the document model hands its `edit()`
 * callback and rewrites it in place, the way `move` and the old private
 * `dropTint` already did. `defaultFor` — what a fresh default *is* for this
 * editor — and `referencedKeys` — the locale keys a parameter list names — sit
 * here too, so the screen and the save path read one copy.
 *
 * Framework-free and DOM-free: `character-parameters.spec.ts` drives it with
 * plain objects and no `TestBed`.
 */

import type {
  CharacterDefinition,
  ControlDefinition,
  ControlKind,
  SettingValue,
} from './character-editor.types';
import { move } from './asset-editing';
import { freeId } from '../../../editing/ids';
import {
  addOption as addControlOption,
  editOption as editControlOption,
  removeOption as removeControlOption,
  setControlKind,
} from '../../../settings/control-list';

/** The label-key namespace every character parameter and option writes into. */
const KEY_PREFIX = 'game.character.';

/**
 * A default this control accepts, given the option values it currently
 * declares.
 *
 * The character editor's numbers and colours, distinct from the settings
 * editor's by design — the two feed their own policy into `setControlKind`.
 */
export function defaultFor(control: ControlKind, options: readonly string[] = []): SettingValue {
  switch (control) {
    case 'toggle':
    case 'checkbox':
      return false;
    case 'slider':
    case 'number':
      return 1;
    case 'color':
      return '#7a5c3e';
    case 'select':
      return options[0] ?? '';
    case 'multiSelect':
      return [];
    case 'text':
      return '';
    case 'keyBinding':
      // The character editor never offers this settings-only control. Keeping
      // the shared union exhaustive makes an imported invalid document fail in
      // Rust instead of leaving this helper with an undefined value.
      return 'KeyQ';
  }
}

/**
 * Every locale key a character definition's parameter list names.
 *
 * The same set the Rust validator walks, in the same order: each parameter's
 * label, its help sentence when it has one, then every option label.
 */
export function referencedKeys(document: CharacterDefinition): string[] {
  const keys: string[] = [];
  for (const parameter of document.parameters ?? []) {
    keys.push(parameter.labelKey);
    if (parameter.helpKey !== undefined) {
      keys.push(parameter.helpKey);
    }
    for (const option of parameter.options ?? []) {
      keys.push(option.labelKey);
    }
  }
  return keys;
}

/**
 * Appends a blank `select` parameter, with a free id and its label key.
 *
 * A `select` with no options and an empty default is what the form opens on;
 * the author names it and adds the choices.
 */
export function addParameter(draft: CharacterDefinition): void {
  const id = freeId(
    'parameter',
    (draft.parameters ?? []).map((parameter) => parameter.id),
  );
  draft.parameters = [
    ...(draft.parameters ?? []),
    { id, labelKey: `${KEY_PREFIX}${id}`, control: 'select', default: '', options: [] },
  ];
}

/**
 * Removes the parameter at `index` and every tint that named it.
 *
 * A tint bound to a parameter that no longer exists would not validate, and
 * the author deleting a parameter is not saying "and break every layer that
 * read it".
 */
export function removeParameter(draft: CharacterDefinition, index: number): void {
  const removed = draft.parameters?.[index];
  draft.parameters?.splice(index, 1);
  if (removed !== undefined) {
    dropTint(draft, removed.id);
  }
}

/** Moves the parameter at `index` by `delta`, which reorders the form. */
export function moveParameter(draft: CharacterDefinition, index: number, delta: number): void {
  move(draft.parameters ?? [], index, delta);
}

/** Applies `change` to the parameter at `index`. */
export function patchParameter(
  draft: CharacterDefinition,
  index: number,
  change: Partial<ControlDefinition>,
): void {
  const parameter = draft.parameters?.[index];
  if (parameter !== undefined) {
    Object.assign(parameter, change);
  }
}

/**
 * Changes what the parameter at `index` *is*, and takes its default with it.
 *
 * The engine refuses a default its own control does not accept, so switching a
 * slider to a select has to replace `1` with an option. A no-op when the index
 * is empty or the control is unchanged.
 */
export function setParameterControl(
  draft: CharacterDefinition,
  index: number,
  control: ControlKind,
): void {
  const parameters = draft.parameters;
  const parameter = parameters?.[index];
  if (parameters === undefined || parameter === undefined || parameter.control === control) {
    return;
  }
  parameters[index] = setControlKind(parameter, control, defaultFor);
}

/**
 * Appends an option to the parameter at `index`, with a free value and its
 * label key. The first option of an empty `select` becomes its default
 * (`control-list.addOption`).
 */
export function addParameterOption(draft: CharacterDefinition, index: number): void {
  const parameters = draft.parameters;
  const parameter = parameters?.[index];
  if (parameters === undefined || parameter === undefined) {
    return;
  }
  const value = freeId(
    'value',
    (parameter.options ?? []).map((option) => option.value),
  );
  parameters[index] = addControlOption(parameter, {
    value,
    labelKey: `${KEY_PREFIX}${value}`,
  });
}

/**
 * Applies `change` to an option of the parameter at `index`.
 *
 * When it renames the value, `control-list.editOption` carries a matching
 * default onto the new name, and this also carries every variant `when` that
 * named the old value — rather than leaving a variant waiting for a value
 * nobody offers any more.
 */
export function editParameterOption(
  draft: CharacterDefinition,
  index: number,
  optionIndex: number,
  change: Partial<{ value: string; labelKey: string }>,
): void {
  const parameters = draft.parameters;
  const parameter = parameters?.[index];
  const option = parameter?.options?.[optionIndex];
  if (parameters === undefined || parameter === undefined || option === undefined) {
    return;
  }
  const previous = option.value;
  parameters[index] = editControlOption(parameter, optionIndex, change);
  if (change.value === undefined || change.value === previous) {
    return;
  }
  for (const layer of draft.layers ?? []) {
    for (const variant of layer.variants) {
      if (variant.when?.[parameter.id] === previous) {
        variant.when[parameter.id] = change.value;
      }
    }
  }
}

/**
 * Removes an option from the parameter at `index`. A `select` default that
 * named it falls to the first remaining option; a `multiSelect` default drops
 * it (`control-list.removeOption`).
 */
export function removeParameterOption(
  draft: CharacterDefinition,
  index: number,
  optionIndex: number,
): void {
  const parameters = draft.parameters;
  const parameter = parameters?.[index];
  if (parameters === undefined || parameter === undefined) {
    return;
  }
  parameters[index] = removeControlOption(parameter, optionIndex);
}

/**
 * Drops every tint bound to `parameterId`, leaving each affected variant its
 * sprite asset and nothing else.
 */
function dropTint(draft: CharacterDefinition, parameterId: string): void {
  for (const layer of draft.layers ?? []) {
    for (const variant of layer.variants) {
      const tint = variant.sprite.tint;
      if (tint && 'parameter' in tint && tint.parameter === parameterId) {
        variant.sprite = { asset: variant.sprite.asset };
      }
    }
  }
}

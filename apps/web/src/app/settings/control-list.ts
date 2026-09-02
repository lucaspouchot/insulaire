/**
 * The list-editing rules a *form for building a control* needs, in one place.
 *
 * A settings field, a character parameter and a character-creation choice or
 * characteristic are the same shape — `crates/world/src/settings.rs`'s
 * `ControlDefinition`. Editing one is four moves: switch the control kind, add
 * an option, edit an option, remove an option. Each move has a rule that keeps
 * the declaration valid the instant it changes — the engine refuses a default
 * its control does not accept, a `select` needs a default among its options — so
 * the form must never produce an invalid file, not even for one frame.
 *
 * These functions own those rules. They take a control and return a new one,
 * leaving the input untouched, so a caller applies the result inside whatever
 * `edit()` its document model has. What a fresh default *is* stays with the
 * caller (`defaultFor`): the settings editor and the character editor pick
 * different numbers and colours by design. So does anything the rules do not
 * govern — a settings field's `scope`, a characteristic's `nullable`.
 *
 * `usesOptions` / `isNumeric` — which kinds carry an option list, which carry
 * bounds — live here too, so every screen reads one copy.
 */

import type { ControlKind, ControlOption, SettingValue } from '../../content/generated/settings';

/** `true` when this control chooses from a declared list of options. */
export function usesOptions(control: ControlKind): boolean {
  return control === 'select' || control === 'multiSelect';
}

/** `true` when this control has `min`, `max` and `step`. */
export function isNumeric(control: ControlKind): boolean {
  return control === 'slider' || control === 'number';
}

/** The structural slice of a control the list rules read and rewrite. */
export interface OptionListControl {
  control: ControlKind;
  default: SettingValue | null;
  options?: ControlOption[];
  min?: number | null;
  max?: number | null;
  step?: number | null;
  unit?: string;
}

/**
 * A starting default a control of `kind` accepts, given the option values it
 * currently declares. Supplied by the caller because the two editors differ.
 */
export type DefaultPolicy = (
  kind: ControlKind,
  optionValues: readonly string[],
) => SettingValue | null;

/**
 * Changes what a control *is*, and drops what the new kind cannot carry.
 *
 * The default is reset to one `kind` accepts. Options are kept for a list kind
 * (normalised to an array) and cleared otherwise; the numeric bounds are kept
 * for a numeric kind and cleared otherwise.
 */
export function setControlKind<T extends OptionListControl>(
  control: T,
  kind: ControlKind,
  defaultFor: DefaultPolicy,
): T {
  const optionValues = (control.options ?? []).map((option) => option.value);
  const next = { ...control, control: kind, default: defaultFor(kind, optionValues) };
  next.options = usesOptions(kind) ? (control.options ?? []) : undefined;
  if (!isNumeric(kind)) {
    next.min = undefined;
    next.max = undefined;
    next.step = undefined;
    next.unit = undefined;
  }
  return next;
}

/**
 * Appends an option. The first option of an empty `select` becomes its default:
 * a select whose default is not one of its own options does not validate.
 */
export function addOption<T extends OptionListControl>(control: T, option: ControlOption): T {
  const options = [...(control.options ?? []), option];
  const isFirstOfSelect = control.control === 'select' && options.length === 1;
  return { ...control, options, default: isFirstOfSelect ? option.value : control.default };
}

/**
 * Applies `patch` to the option at `index`. When it renames the value, a
 * default that named the old one follows it, rather than being left pointing at
 * a value nobody declares any more.
 */
export function editOption<T extends OptionListControl>(
  control: T,
  index: number,
  patch: Partial<ControlOption>,
): T {
  const current = control.options?.[index];
  if (current === undefined) {
    return control;
  }
  const options = (control.options ?? []).map((option, at) =>
    at === index ? { ...option, ...patch } : option,
  );
  const renamed = patch.value !== undefined && patch.value !== current.value;
  return {
    ...control,
    options,
    default: renamed && control.default === current.value ? patch.value : control.default,
  };
}

/**
 * Removes the option at `index`. A `select` default that named it falls to the
 * first remaining option; a `multiSelect` default drops it from the list.
 */
export function removeOption<T extends OptionListControl>(control: T, index: number): T {
  const removed = control.options?.[index];
  if (removed === undefined) {
    return control;
  }
  const options = (control.options ?? []).filter((_option, at) => at !== index);
  let nextDefault = control.default;
  if (control.control === 'select' && control.default === removed.value) {
    nextDefault = options[0]?.value ?? '';
  } else if (control.control === 'multiSelect' && Array.isArray(control.default)) {
    nextDefault = control.default.filter((entry) => entry !== removed.value);
  }
  return { ...control, options, default: nextDefault };
}

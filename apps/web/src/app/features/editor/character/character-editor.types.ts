/**
 * The shapes the character editor works with, and the small amount of knowledge
 * a *form for building a character* needs.
 *
 * The model itself is `crates/world/src/character.rs`, mirrored in
 * `content-types.ts`; what lives here is only which categories the picker
 * offers, and what a freshly added parameter, layer or variant should look like
 * so that it validates the moment it exists (`docs/adr/ADR-0028-character-
 * definitions.md`, `docs/adr/ADR-0029-characters-are-composed-sprites.md`).
 *
 * Note what is *not* here: nothing knows that a player has a gender or that a
 * goblin has armour. Those are values an author types.
 */

import {
  CharacterCategory,
  ControlKind,
  LayerVariant,
  MAX_SPRITE_RESOLUTION,
  SpriteResolution,
} from '../../../../content/content-types';

export { MAX_SPRITE_RESOLUTION } from '../../../../content/content-types';

export type {
  CharacterCategory,
  CharacterDefinition,
  CharacterLayer,
  CharacterValues,
  ColorSource,
  ControlDefinition,
  ControlKind,
  LayerVariant,
  PixelRect,
  ResolvedCharacter,
  SettingValue,
  Sprite,
  SpriteResolution,
} from '../../../../content/content-types';

/** Every category, in the order the picker offers them, with its label. */
export const CATEGORIES: readonly { readonly id: CharacterCategory; readonly labelKey: string }[] =
  [
    { id: 'player', labelKey: 'ui.editor.character.categories.player' },
    { id: 'npc', labelKey: 'ui.editor.character.categories.npc' },
    { id: 'enemy', labelKey: 'ui.editor.character.categories.enemy' },
    { id: 'monster', labelKey: 'ui.editor.character.categories.monster' },
    { id: 'other', labelKey: 'ui.editor.character.categories.other' },
  ];

/**
 * The control kinds a character parameter may use.
 *
 * The same vocabulary as the settings editor: a parameter *is* a
 * `ControlDefinition`, and this is only the order the picker offers them in.
 */
export const CONTROL_KINDS: readonly ControlKind[] = [
  'select',
  'color',
  'slider',
  'number',
  'toggle',
  'checkbox',
  'multiSelect',
  'text',
];

/** `true` when this control chooses from a declared list of options. */
export function usesOptions(control: ControlKind): boolean {
  return control === 'select' || control === 'multiSelect';
}

/** `true` when this control has `min`, `max` and `step` — and can drive a scale. */
export function isNumeric(control: ControlKind): boolean {
  return control === 'slider' || control === 'number';
}

/**
 * A first variant for a layer that has just been created.
 *
 * It names no image yet, which is not an oversight: the renderer draws an
 * outline where a missing sprite would go, so a layer can be placed on the
 * canvas before any art exists
 * (`docs/adr/ADR-0029-characters-are-composed-sprites.md`).
 */
export function blankVariant(id: string, resolution: SpriteResolution): LayerVariant {
  // A box a quarter of the canvas, centred: visible straight away, which is the
  // point of adding a layer at all.
  const width = Math.max(1, Math.round(resolution.width / 3));
  const height = Math.max(1, Math.round(resolution.height / 4));
  return {
    id,
    rect: [
      Math.round((resolution.width - width) / 2),
      Math.round((resolution.height - height) / 2),
      width,
      height,
    ],
    sprite: { asset: '' },
  };
}

/** A canvas side clamped into what a definition may declare. */
export function clampResolution(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(MAX_SPRITE_RESOLUTION, Math.max(1, Math.round(value)));
}

/** `<stem>`, `<stem>_2`, … — the first one nobody is using. */
export function freeId(stem: string, taken: readonly string[]): string {
  if (!taken.includes(stem)) {
    return stem;
  }
  let index = 2;
  while (taken.includes(`${stem}_${index}`)) {
    index += 1;
  }
  return `${stem}_${index}`;
}

/** Moves one entry of an array, staying inside it. */
export function move<T>(items: T[], index: number, delta: number): void {
  const target = index + delta;
  if (target < 0 || target >= items.length) {
    return;
  }
  const [moved] = items.splice(index, 1);
  if (moved !== undefined) {
    items.splice(target, 0, moved);
  }
}

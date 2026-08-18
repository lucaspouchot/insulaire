/**
 * The shapes the character editor works with, and the small amount of knowledge
 * a *form for building a character* needs.
 *
 * The model itself is `crates/world/src/character.rs`, mirrored in
 * `content-types.ts`; what lives here is only which categories and modes the
 * pickers offer, and what a freshly added parameter, layer or variant should
 * look like so that it validates the moment it exists
 * (`docs/adr/ADR-0028-character-definitions.md`).
 *
 * Note what is *not* here: nothing knows that a player has a gender or that a
 * goblin has armour. Those are values an author types.
 */

import {
  CharacterCategory,
  ControlKind,
  LayerVariant,
  RenderingMode,
  ShapeKind,
} from '../../../../content/content-types';

export type {
  CharacterCategory,
  CharacterDefinition,
  CharacterLayer,
  CharacterValues,
  ColorSource,
  ControlDefinition,
  ControlKind,
  LayerVariant,
  LayerVisual,
  RenderingMode,
  ResolvedCharacter,
  SettingValue,
  ShapeKind,
  UnitRect,
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

/** Every rendering mode, in the order the picker offers them. */
export const RENDERING_MODES: readonly {
  readonly id: RenderingMode;
  readonly labelKey: string;
}[] = [
  { id: 'procedural', labelKey: 'ui.editor.character.rendering.procedural' },
  { id: 'assetComposition', labelKey: 'ui.editor.character.rendering.assetComposition' },
];

/** Every shape a procedural layer can take. */
export const SHAPE_KINDS: readonly { readonly id: ShapeKind; readonly labelKey: string }[] = [
  { id: 'rect', labelKey: 'ui.editor.character.shapes.rect' },
  { id: 'ellipse', labelKey: 'ui.editor.character.shapes.ellipse' },
  { id: 'triangle', labelKey: 'ui.editor.character.shapes.triangle' },
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
 * Procedural by default because a new project has no images yet; an
 * asset-composed character gets a sprite variant instead, so that a definition
 * never contradicts the rendering mode it declares.
 */
export function blankVariant(id: string, rendering: RenderingMode): LayerVariant {
  return {
    id,
    // Roughly a torso: something visible in the preview, which is the point of
    // adding a layer at all.
    rect: [0.35, 0.4, 0.3, 0.35],
    visual:
      rendering === 'assetComposition'
        ? { kind: 'sprite', asset: '' }
        : { kind: 'shape', shape: 'rect', color: { fixed: '#7a5c3e' } },
  };
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

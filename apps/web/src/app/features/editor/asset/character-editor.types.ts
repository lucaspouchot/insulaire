/**
 * The shapes the character editor works with, and the small amount of knowledge
 * a *form for building a character* needs.
 *
 * The model itself is `crates/world/src/character.rs`, mirrored in
 * `content-types.ts`; what lives here is only which categories the picker
 * offers, and what a freshly added parameter, layer or variant should look like
 * so that it validates the moment it exists
 * (`docs/adr/ADR-0024-character-definitions.md`).
 *
 * The animation half is the same kind of knowledge: what a new animation should
 * look like, how the layer tree flattens into rows a list can render, whether a
 * parent would close a loop, and what value a new keyframe starts from
 * (`docs/adr/ADR-0025-characters-animate-by-hierarchy-and-offsets.md`).
 * **Evaluating** an animation is not here and never will be — that is the
 * engine's, and a second evaluator would be a second answer.
 *
 * Note what is *not* here: nothing knows that a player has a gender or that a
 * goblin has armour. Those are values an author types.
 */

import {
  Animation,
  AnimationRole,
  AnimationTrack,
  CharacterCategory,
  CharacterLayer,
  ControlKind,
  DEFAULT_FRAME_DURATION_MS,
  Keyframe,
  LayerVariant,
  PoseKey,
  SettingValue,
  MAX_ANIMATION_FRAMES,
  PixelOffset,
  SpriteResolution,
} from '../../../../content/content-types';

export {
  DEFAULT_FRAME_DURATION_MS,
  MAX_ANIMATION_FRAMES,
  MAX_SPRITE_RESOLUTION,
} from '../../../../content/content-types';

export type {
  Animation,
  AnimationRole,
  AnimationTrack,
  AttachmentPoint,
  CharacterCategory,
  CharacterDefinition,
  CharacterLayer,
  CharacterValues,
  ColorSource,
  ControlDefinition,
  ControlKind,
  Interpolation,
  Keyframe,
  LayerVariant,
  PixelOffset,
  PixelRect,
  PoseKey,
  ResolvedCharacter,
  ResolvedLayer,
  SettingValue,
  Sprite,
  SpriteResolution,
} from '../../../../content/content-types';

/** Gameplay animation roles, in the order the editor offers them. */
export const ANIMATION_ROLES: readonly {
  readonly id: AnimationRole;
  readonly labelKey: string;
}[] = [
  { id: 'idle', labelKey: 'ui.editor.character.animationRoles.idle' },
  { id: 'moveLeft', labelKey: 'ui.editor.character.animationRoles.moveLeft' },
  { id: 'moveRight', labelKey: 'ui.editor.character.animationRoles.moveRight' },
  { id: 'moveEast', labelKey: 'ui.editor.character.animationRoles.moveEast' },
  { id: 'moveNorthEast', labelKey: 'ui.editor.character.animationRoles.moveNorthEast' },
  { id: 'moveNorthWest', labelKey: 'ui.editor.character.animationRoles.moveNorthWest' },
  { id: 'moveWest', labelKey: 'ui.editor.character.animationRoles.moveWest' },
  { id: 'moveSouthWest', labelKey: 'ui.editor.character.animationRoles.moveSouthWest' },
  { id: 'moveSouthEast', labelKey: 'ui.editor.character.animationRoles.moveSouthEast' },
];

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
 * Which module of the inspector is open.
 *
 * Grouped by the question each answers — which character, what may be chosen
 * about it, what it is drawn from, how it moves — because seven panels stacked
 * in one scroller meant scrolling past four to reach the fifth.
 *
 * The timeline is wide, and this is a column; what makes that work is that the
 * column is **resizable**, so an author editing an animation drags the
 * inspector open and gets the width back from the scene
 * (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`).
 */
export type EditorTab = 'character' | 'parameters' | 'layers' | 'animation';

/** The tabs, in the order they are offered, with their labels. */
export const EDITOR_TABS: readonly { readonly id: EditorTab; readonly labelKey: string }[] = [
  { id: 'character', labelKey: 'ui.editor.character.tabCharacter' },
  { id: 'parameters', labelKey: 'ui.editor.character.tabParameters' },
  { id: 'layers', labelKey: 'ui.editor.character.tabLayers' },
  { id: 'animation', labelKey: 'ui.editor.character.tabAnimation' },
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
 * (`docs/adr/ADR-0024-character-definitions.md`).
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

// ------------------------------------------------------------------ animation

/**
 * How many frames a freshly created animation is, and how long each lasts.
 *
 * Four frames of an eighth of a second is a breathing idle — the animation an
 * author is most likely to be creating when they press the button.
 */
const NEW_ANIMATION_FRAMES = 4;

/** An animation that has just been created: named, looping, and empty. */
export function blankAnimation(id: string): Animation {
  return {
    id,
    name: id,
    frames: NEW_ANIMATION_FRAMES,
    frameDurationMs: DEFAULT_FRAME_DURATION_MS,
    looping: true,
    tracks: [],
  };
}

/** A frame count clamped into what an animation may declare. */
export function clampFrames(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(MAX_ANIMATION_FRAMES, Math.max(1, Math.round(value)));
}

/** A frame duration clamped to something that can actually be played. */
export function clampDuration(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_FRAME_DURATION_MS;
  }
  return Math.min(10_000, Math.max(1, Math.round(value)));
}

/** The keyframe this track writes at exactly this frame, if it writes one. */
export function keyframeAt(track: AnimationTrack | undefined, frame: number): Keyframe | undefined {
  return track?.keyframes.find((keyframe) => keyframe.frame === frame);
}

/**
 * The offset a *new* keyframe at this frame should start from.
 *
 * The engine owns evaluation — this is not a second evaluator, and it does not
 * interpolate. It answers an authoring question: dragging a node that has no
 * keyframe here should move it from where it currently sits, which is the last
 * value written at or before this frame, or the first one written at all
 * (`docs/adr/ADR-0025-characters-animate-by-hierarchy-and-offsets.md`).
 */
export function heldOffset(track: AnimationTrack | undefined, frame: number): PixelOffset {
  const keyframes = track?.keyframes ?? [];
  if (keyframes.length === 0) {
    return [0, 0];
  }
  const sorted = [...keyframes].sort((left, right) => left.frame - right.frame);
  const previous = sorted.filter((keyframe) => keyframe.frame <= frame).at(-1);
  return (previous ?? sorted[0])?.offset ?? [0, 0];
}

/** The pose an animation writes at exactly this frame, if it writes one. */
export function poseAt(animation: Animation | null, frame: number): PoseKey | undefined {
  return (animation?.poses ?? []).find((key) => key.frame === frame);
}

/**
 * The pose in force at this frame, whichever frame wrote it.
 *
 * The engine's rule, mirrored for the timeline to draw: the last entry at or
 * before this frame, and failing that the first one written at all — a pose
 * holds in both directions (`crates/world/src/animation.rs`).
 */
export function heldPose(animation: Animation | null, frame: number): PoseKey | undefined {
  const poses = [...(animation?.poses ?? [])].sort((left, right) => left.frame - right.frame);
  return poses.filter((key) => key.frame <= frame).at(-1) ?? poses[0];
}

/**
 * What an author typed, as the value a `when` condition will be compared with.
 *
 * `true`, `false` and numbers are read as themselves, because that is what a
 * toggle and a slider put in the customisation — a pose that wrote the string
 * `"true"` would never match a variant waiting for the boolean.
 */
export function poseValue(raw: string): SettingValue {
  const text = raw.trim();
  if (text === 'true' || text === 'false') {
    return text === 'true';
  }
  if (text.length > 0 && Number.isFinite(Number(text))) {
    return Number(text);
  }
  return raw;
}

/**
 * `true` when making `layer` hang off `parent` would close a loop.
 *
 * The check the picker runs *before* offering a parent, rather than the
 * validator's report afterwards: a cycle is never something an author meant,
 * and the cheapest place to refuse it is the list it would be chosen from.
 */
export function wouldLoop(
  layers: readonly CharacterLayer[],
  layerId: string,
  parentId: string,
): boolean {
  if (layerId === parentId) {
    return true;
  }
  const seen = new Set<string>([parentId]);
  let node = layers.find((candidate) => candidate.id === parentId);

  while (node?.parent) {
    if (node.parent === layerId) {
      return true;
    }
    if (seen.has(node.parent)) {
      return false;
    }
    seen.add(node.parent);
    node = layers.find((candidate) => candidate.id === node?.parent);
  }
  return false;
}

/** One row of the hierarchy, flattened for display. */
export interface HierarchyRow {
  readonly layer: CharacterLayer;
  /** How many parents it has, for the indent. */
  readonly depth: number;
  /** Where it sits in the definition's own list — which is the draw order. */
  readonly index: number;
}

/**
 * The layer tree, flattened depth-first for a list to render.
 *
 * Roots keep their author order — which is the draw order — and children follow
 * theirs under each parent. A layer whose parent does not exist is shown as a
 * root, so a broken reference is visible rather than invisible; validation is
 * what names it (`character.unknownParent`).
 */
export function hierarchy(layers: readonly CharacterLayer[]): HierarchyRow[] {
  const rows: HierarchyRow[] = [];
  const known = new Set(layers.map((layer) => layer.id));
  const childrenOf = (parent: string | null): CharacterLayer[] =>
    layers.filter((layer) => {
      const declared = layer.parent ?? null;
      const resolved = declared !== null && known.has(declared) ? declared : null;
      return resolved === parent;
    });

  const walk = (parent: string | null, depth: number, seen: Set<string>): void => {
    for (const layer of childrenOf(parent)) {
      // A cycle would otherwise walk for ever. Validation reports it; the list
      // just stops descending.
      if (seen.has(layer.id)) {
        continue;
      }
      rows.push({ layer, depth, index: layers.indexOf(layer) });
      walk(layer.id, depth + 1, new Set([...seen, layer.id]));
    }
  };
  walk(null, 0, new Set());

  // Anything a cycle kept out of the walk is still listed, at the top level:
  // an editor that hides a layer is an editor that cannot fix it.
  for (const layer of layers) {
    if (!rows.some((row) => row.layer.id === layer.id)) {
      rows.push({ layer, depth: 0, index: layers.indexOf(layer) });
    }
  }
  return rows;
}

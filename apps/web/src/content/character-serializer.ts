/**
 * Writes a {@link CharacterDefinition} back out as a content file.
 *
 * The same reasoning as `settings-serializer.ts`: the engine fills every
 * optional field in before the editor sees a definition, so
 * `JSON.stringify(_, null, 2)` would turn a one-line variant into fifteen and
 * put `"min": null` next to a colour. A character file is read and diffed by
 * people, so this writes what an author would have written.
 *
 * The layout that matters is the **variant**: one per line, conditions and
 * geometry and sprite all visible at once, which is what makes a diff of "the
 * hair moved up two pixels" readable — and with pixel geometry, that diff now
 * says exactly that.
 *
 * ```json
 * "variants": [
 *   { "id": "default", "rect": [23, 10, 18, 20], "sprite": { "asset": "…png" } }
 * ]
 * ```
 *
 * An **animation** follows the same rule with the *keyframe* as the unit, and
 * again with the *pose*: one per line, frame and value side by side, so "the
 * body drops a pixel later in the loop" and "frame 2 is the other contact" are
 * each one changed line.
 *
 * ```json
 * "poses": [
 *   { "frame": 1, "step": "pass" }
 * ],
 * "keyframes": [
 *   { "frame": 1, "offset": [0, -2] }
 * ]
 * ```
 *
 * What is dropped is what parses back to the value dropped, which the `_ABSENT`
 * tables state once, from the definitions themselves. A `mirrorOf` animation
 * writes nothing but its id, name, optional gameplay role and source: its
 * timing, its tracks and its sprites all belong to the animation it reflects,
 * and writing fields nothing reads is how a file starts lying about itself.
 * `category` and `resolution` are always written — they are what the file is
 * *about*, and a reader should not have to know the defaults. `scope` is never
 * written: it belongs to the settings vocabulary and means nothing to a
 * character (`docs/adr/ADR-0024-character-definitions.md`). See
 * `canonical-json.ts` for the layout these tables are read by.
 */

import {
  blockOf,
  canonicalJson,
  list,
  member,
  Node,
  row,
  rowOf,
  Shape,
  value,
} from './canonical-json';
import {
  ANIMATION_ABSENT,
  Animation,
  AnimationTrack,
  AttachmentPoint,
  CHARACTER_ABSENT,
  CHARACTER_LAYER_ABSENT,
  CharacterDefinition,
  CharacterLayer,
  KEYFRAME_ABSENT,
  Keyframe,
  LAYER_VARIANT_ABSENT,
  LayerVariant,
  PoseKey,
  SPRITE_ABSENT,
  Sprite,
} from './generated/character';
import { CONTROL_ABSENT, ControlDefinition } from './generated/settings';
import { CONTROL_FIELDS } from './settings-serializer';

/** A character parameter: the settings vocabulary, minus what it ignores. */
const PARAMETER: Shape<ControlDefinition> = {
  absent: CONTROL_ABSENT,
  fields: { ...CONTROL_FIELDS, scope: 'never' },
};

const SPRITE: Shape<Sprite> = {
  absent: SPRITE_ABSENT,
  fields: { asset: 'always', tint: 'unless-redundant' },
};

/** A whole variant on one line. */
const VARIANT: Shape<LayerVariant> = {
  absent: LAYER_VARIANT_ABSENT,
  fields: {
    id: 'always',
    when: 'unless-redundant',
    rect: 'always',
    order: 'unless-redundant',
    sprite: { write: 'always', as: (sprite) => rowOf(sprite, SPRITE) },
  },
};

/** One attachment point, on one line. */
const ANCHOR: Shape<AttachmentPoint> = {
  fields: { id: 'always', at: 'always' },
};

/**
 * One layer: a heading, where it hangs, its anchors, and its variants.
 *
 * A root layer writes no `parent`, and a layer hanging off its parent's origin
 * writes no `parentAnchor`: absent is the common case, and the common case
 * should be invisible in the file.
 */
const LAYER: Shape<CharacterLayer> = {
  absent: CHARACTER_LAYER_ABSENT,
  fields: {
    id: 'always',
    parent: 'unless-redundant',
    parentAnchor: 'unless-redundant',
    anchors: {
      write: 'unless-redundant',
      as: (anchors) => list(anchors.map((anchor) => rowOf(anchor, ANCHOR))),
    },
    variants: {
      write: 'always',
      as: (variants) => list(variants.map((variant) => rowOf(variant, VARIANT))),
    },
  },
};

/** A whole keyframe on one line; `step` is the default and is not written. */
const KEYFRAME: Shape<Keyframe> = {
  absent: KEYFRAME_ABSENT,
  fields: { frame: 'always', offset: 'always', interpolation: 'unless-redundant' },
};

/** One track: the node it drives and its keyframes, one per line. */
const TRACK: Shape<AnimationTrack> = {
  fields: {
    node: 'always',
    keyframes: {
      write: 'always',
      as: (keyframes) => list(keyframes.map((keyframe) => rowOf(keyframe, KEYFRAME))),
    },
  },
};

/** Whether an animation has timing of its own, or reflects another's. */
function played(animation: Animation): boolean {
  return !animation.mirrorOf;
}

/** A whole pose entry on one line, its values flattened beside its frame. */
function poseRow(key: PoseKey): Node {
  const values = Object.entries(key)
    .filter(([id, held]) => id !== 'frame' && held !== undefined)
    .map(([id, held]) => member(id, value(held)));
  return row([member('frame', value(key.frame)), ...values]);
}

/**
 * One animation: a heading and one block per track.
 *
 * The layout that matters here is the **keyframe**: one per line, frame and
 * offset side by side, so a diff of "the body drops a pixel later in the loop"
 * reads as exactly that. The pose comes before the tracks because it is read
 * first: what the character is drawn *as*, then how far it moved from there.
 */
const ANIMATION: Shape<Animation> = {
  absent: ANIMATION_ABSENT,
  fields: {
    id: 'always',
    name: 'unless-redundant',
    role: 'unless-redundant',
    mirrorOf: 'unless-redundant',
    frames: { write: played },
    frameDurationMs: { write: played },
    looping: { write: played },
    pose: { write: (animation) => played(animation) && holds(animation.pose) },
    poses: {
      write: (animation) => played(animation) && (animation.poses ?? []).length > 0,
      as: (poses) => list(poses.map(poseRow)),
    },
    tracks: {
      write: played,
      as: (tracks) => list(tracks.map((track) => blockOf(track, TRACK))),
    },
  },
};

/** Whether a flat map of values holds any. */
function holds(values: Record<string, unknown> | undefined): boolean {
  return Object.keys(values ?? {}).length > 0;
}

/** The character file, field by field, in the order it states them. */
const CHARACTER: Shape<CharacterDefinition> = {
  absent: CHARACTER_ABSENT,
  fields: {
    id: 'always',
    schemaVersion: 'always',
    name: 'unless-redundant',
    category: 'always',
    resolution: 'always',
    parameters: {
      write: 'always',
      as: (parameters) => list(parameters.map((parameter) => blockOf(parameter, PARAMETER))),
    },
    layers: {
      write: 'always',
      as: (layers) => list(layers.map((layer) => blockOf(layer, LAYER))),
    },
    // Dropped entirely when there are none: a still character should not carry
    // an empty list saying it might have moved.
    animations: {
      write: 'unless-redundant',
      as: (animations) => list(animations.map((animation) => blockOf(animation, ANIMATION))),
    },
  },
};

/** The character file, in the canonical layout. */
export function serializeCharacter(character: CharacterDefinition): string {
  return canonicalJson(blockOf(character, CHARACTER));
}

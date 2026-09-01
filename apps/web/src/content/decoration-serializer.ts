/**
 * Writes a {@link DecorationDefinition} back out as a content file.
 *
 * The same reasoning as `character-serializer.ts`: the engine fills every
 * optional field in before the editor sees a definition, so
 * `JSON.stringify(_, null, 2)` would spread a two-frame flame over twelve lines
 * and write `"name": ""` next to it. A decoration file is read and diffed by
 * people, so this writes what an author would have written.
 *
 * The layout that matters is the **animation**: its identity on one line, then
 * one frame per line, so "the third frame of the flame changed image" and "the
 * chest gained an open state" are each one changed line.
 *
 * ```json
 * "animations": [
 *   {
 *     "id": "burning",
 *     "frameDurationMs": 100,
 *     "looping": true,
 *     "frames": [
 *       "assets/decorations/torch_0.png",
 *       "assets/decorations/torch_1.png"
 *     ]
 *   }
 * ]
 * ```
 *
 * What is dropped is what parses back to the value dropped — `DECORATION_ABSENT`
 * and `DECORATION_ANIMATION_ABSENT` say what that is, from the definitions
 * themselves — plus a `defaultAnimation` that names the first one anyway. What
 * is **always** written is what the file is *about* and what a reader should not
 * have to know the defaults of: `category`, `resolution`, `anchor`, `plane` and
 * `order` (`docs/adr/ADR-0035-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
 * See `canonical-json.ts` for the layout these tables are read by.
 */

import { blockOf, canonicalJson, list, Shape, value } from './canonical-json';
import {
  DECORATION_ABSENT,
  DECORATION_ANIMATION_ABSENT,
  DecorationAnimation,
  DecorationDefinition,
} from './generated/decoration';

/** One animation: its identity, then one frame per line. */
const ANIMATION: Shape<DecorationAnimation> = {
  absent: DECORATION_ANIMATION_ABSENT,
  fields: {
    id: 'always',
    name: 'unless-redundant',
    frameDurationMs: 'always',
    looping: 'always',
    frames: { write: 'always', as: (frames) => list(frames.map((frame) => value(frame))) },
  },
};

/**
 * Whether a decoration names a default other than the one it already has.
 *
 * A default naming the first animation is what "absent" already means, so
 * writing it would be a field that says nothing.
 */
function namesAnotherDefault(decoration: DecorationDefinition): boolean {
  const animations = decoration.animations ?? [];
  return (
    decoration.defaultAnimation !== undefined &&
    decoration.defaultAnimation.length > 0 &&
    decoration.defaultAnimation !== (animations[0]?.id ?? '')
  );
}

/** The decoration file, field by field, in the order it states them. */
const DECORATION: Shape<DecorationDefinition> = {
  absent: DECORATION_ABSENT,
  fields: {
    id: 'always',
    schemaVersion: 'always',
    name: 'unless-redundant',
    category: 'always',
    resolution: 'always',
    anchor: 'always',
    plane: 'always',
    order: 'always',
    tags: 'unless-redundant',
    defaultAnimation: { write: namesAnotherDefault },
    animations: {
      write: 'unless-redundant',
      as: (animations) => list(animations.map((animation) => blockOf(animation, ANIMATION))),
    },
  },
};

/** The decoration file, in the canonical layout. */
export function serializeDecoration(decoration: DecorationDefinition): string {
  return canonicalJson(blockOf(decoration, DECORATION));
}

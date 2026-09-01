/**
 * Writes an {@link ObjectDefinition} back out as a content file.
 *
 * An object is flat — no layers, no skeleton, no tracks — so this is the
 * smallest of the layouts, and it is written for the same reason the others
 * are: an object file is read and diffed by people, and a definition
 * round-tripped through `JSON.stringify` would carry `"slot": ""` and
 * `"tags": []` on every potion in the game
 * (`docs/adr/ADR-0036-an-object-is-carried-not-placed.md`).
 *
 * The icon is a **flipbook**, one frame per line, so "the third frame of the
 * glint changed image" is one changed line
 * (`docs/adr/ADR-0036-an-object-is-carried-not-placed.md`).
 *
 * ```json
 * {
 *   "id": "small_potion",
 *   "schemaVersion": 2,
 *   "kind": "consumable",
 *   "nameKey": "game.object.smallPotion.name",
 *   "frames": [
 *     "assets/objects/small_potion.png"
 *   ],
 *   "resolution": { "width": 16, "height": 16 },
 *   "stackSize": 10
 * }
 * ```
 *
 * What is dropped is what parses back to the value dropped — `OBJECT_ABSENT`
 * says what that is, from the definition itself. What is always written is
 * `kind`, `nameKey`, `frames` and `resolution` — what the file is *about*,
 * including while they are still empty, because an object being blocked out
 * should show the fields it still owes. See `canonical-json.ts` for the layout
 * this table is read by.
 */

import { blockOf, canonicalJson, list, Shape, value } from './canonical-json';
import { OBJECT_ABSENT, ObjectDefinition } from './generated/object';

/** Whether an icon has a playback at all: one drawing has nothing to loop. */
function animated(object: ObjectDefinition): boolean {
  return (object.frames ?? []).length > 1;
}

/** The object file, field by field, in the order it states them. */
const OBJECT: Shape<ObjectDefinition> = {
  absent: OBJECT_ABSENT,
  fields: {
    id: 'always',
    schemaVersion: 'always',
    name: 'unless-redundant',
    kind: 'always',
    nameKey: 'always',
    descriptionKey: 'unless-redundant',
    // One frame per line, so a changed drawing is a changed line.
    frames: { write: 'always', as: (frames) => list(frames.map((frame) => value(frame))) },
    // A still icon states no rate and loops nothing: both would be fields about
    // a playback that never happens.
    frameDurationMs: { write: animated },
    looping: { write: animated },
    resolution: 'always',
    stackSize: 'unless-redundant',
    slot: 'unless-redundant',
    tags: 'unless-redundant',
  },
};

/** The object file, in the canonical layout. */
export function serializeObject(object: ObjectDefinition): string {
  return canonicalJson(blockOf(object, OBJECT));
}

/**
 * Writes an {@link ObjectDefinition} back out as a content file.
 *
 * An object is flat — no layers, no skeleton, no tracks — so this is the
 * smallest of the serialisers, and it is written for the same reason the others
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
 * What is dropped is what parses back to the value dropped: an empty `name`,
 * `descriptionKey`, `slot` or `tags`, a `stackSize` of `1`, and the playback
 * fields of a **still** icon — one drawing has no rate to state and nothing to
 * loop. What is always written is `kind`, `nameKey`, `frames` and `resolution`
 * — what the file is *about*, including while they are still empty, because an
 * object being blocked out should show the fields it still owes.
 */

import {
  DEFAULT_ICON_RESOLUTION,
  DEFAULT_FRAME_DURATION_MS,
  ObjectDefinition,
} from './content-types';

/** The object file, in the canonical layout. */
export function serializeObject(object: ObjectDefinition): string {
  const lines = ['{', `  "id": ${JSON.stringify(object.id)},`];
  lines.push(`  "schemaVersion": ${JSON.stringify(object.schemaVersion)},`);
  if (object.name) {
    lines.push(`  "name": ${JSON.stringify(object.name)},`);
  }
  lines.push(`  "kind": ${JSON.stringify(object.kind ?? 'other')},`);
  lines.push(`  "nameKey": ${JSON.stringify(object.nameKey ?? '')},`);
  if (object.descriptionKey) {
    lines.push(`  "descriptionKey": ${JSON.stringify(object.descriptionKey)},`);
  }
  const frames = object.frames ?? [];
  if (frames.length === 0) {
    lines.push('  "frames": [],');
  } else {
    lines.push('  "frames": [');
    frames.forEach((frame, index) => {
      lines.push(`    ${JSON.stringify(frame)}${index === frames.length - 1 ? '' : ','}`);
    });
    lines.push('  ],');
  }

  // A still icon states no rate and loops nothing: both would be fields about
  // a playback that never happens.
  if (frames.length > 1) {
    lines.push(
      `  "frameDurationMs": ${JSON.stringify(object.frameDurationMs ?? DEFAULT_FRAME_DURATION_MS)},`,
    );
    lines.push(`  "looping": ${JSON.stringify(object.looping === true)},`);
  }

  const resolution = object.resolution ?? DEFAULT_ICON_RESOLUTION;
  lines.push(
    `  "resolution": { "width": ${JSON.stringify(resolution.width)}, ` +
      `"height": ${JSON.stringify(resolution.height)} },`,
  );

  // `1` is what an absent stack size already means, and every quest item has it.
  if ((object.stackSize ?? 1) !== 1) {
    lines.push(`  "stackSize": ${JSON.stringify(object.stackSize)},`);
  }
  if (object.slot) {
    lines.push(`  "slot": ${JSON.stringify(object.slot)},`);
  }

  const tags = object.tags ?? [];
  if (tags.length > 0) {
    lines.push(`  "tags": [${tags.map((tag) => JSON.stringify(tag)).join(', ')}],`);
  }

  // The last entry carries no comma, whichever one it turned out to be.
  const last = lines.length - 1;
  lines[last] = (lines[last] as string).replace(/,$/, '');

  lines.push('}');
  return `${lines.join('\n')}\n`;
}

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
 * What is dropped is what parses back to the value dropped: an empty `name` on
 * the decoration or on an animation, an empty `tags`, a `defaultAnimation` that
 * names the first one anyway, and the whole `animations` list when there is
 * none. What is **always** written is what the file is *about* and what a
 * reader should not have to know the defaults of: `category`, `resolution`,
 * `anchor`, `plane` and `order`
 * (`docs/adr/ADR-0048-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
 */

import {
  DecorationAnimation,
  DecorationDefinition,
  DEFAULT_DECORATION_RESOLUTION,
  DEFAULT_FRAME_DURATION_MS,
  PixelOffset,
} from './content-types';

/** The decoration file, in the canonical layout. */
export function serializeDecoration(decoration: DecorationDefinition): string {
  const lines = ['{', `  "id": ${JSON.stringify(decoration.id)},`];
  lines.push(`  "schemaVersion": ${JSON.stringify(decoration.schemaVersion)},`);
  if (decoration.name) {
    lines.push(`  "name": ${JSON.stringify(decoration.name)},`);
  }
  lines.push(`  "category": ${JSON.stringify(decoration.category ?? 'other')},`);

  const resolution = decoration.resolution ?? DEFAULT_DECORATION_RESOLUTION;
  lines.push(
    `  "resolution": { "width": ${JSON.stringify(resolution.width)}, ` +
      `"height": ${JSON.stringify(resolution.height)} },`,
  );
  lines.push(`  "anchor": ${offset(decoration.anchor ?? [0, 0])},`);
  lines.push(`  "plane": ${JSON.stringify(decoration.plane ?? 'behind')},`);
  lines.push(`  "order": ${JSON.stringify(decoration.order ?? 0)},`);

  const tags = decoration.tags ?? [];
  if (tags.length > 0) {
    lines.push(`  "tags": [${tags.map((tag) => JSON.stringify(tag)).join(', ')}],`);
  }

  const animations = decoration.animations ?? [];
  // A default naming the first animation is what "absent" already means, so
  // writing it would be a field that says nothing.
  const fallback = animations[0]?.id ?? '';
  if (decoration.defaultAnimation && decoration.defaultAnimation !== fallback) {
    lines.push(`  "defaultAnimation": ${JSON.stringify(decoration.defaultAnimation)},`);
  }

  if (animations.length > 0) {
    lines.push('  "animations": [');
    animations.forEach((animation, index) => {
      const block = animationLines(animation, 4);
      const last = block.length - 1;
      block[last] = `${block[last] as string}${index === animations.length - 1 ? '' : ','}`;
      lines.push(...block);
    });
    lines.push('  ]');
  } else {
    // The last entry carries no comma, whichever one it turned out to be.
    const last = lines.length - 1;
    lines[last] = (lines[last] as string).replace(/,$/, '');
  }

  lines.push('}');
  return `${lines.join('\n')}\n`;
}

/** One animation: its identity, then one frame per line. */
function animationLines(animation: DecorationAnimation, indent: number): string[] {
  const pad = ' '.repeat(indent);
  const lines = [`${pad}{`, `${pad}  "id": ${JSON.stringify(animation.id)},`];
  if (animation.name) {
    lines.push(`${pad}  "name": ${JSON.stringify(animation.name)},`);
  }
  lines.push(
    `${pad}  "frameDurationMs": ${JSON.stringify(
      animation.frameDurationMs ?? DEFAULT_FRAME_DURATION_MS,
    )},`,
  );
  lines.push(`${pad}  "looping": ${JSON.stringify(animation.looping === true)},`);

  const frames = animation.frames ?? [];
  if (frames.length === 0) {
    lines.push(`${pad}  "frames": []`);
  } else {
    lines.push(`${pad}  "frames": [`);
    frames.forEach((frame, index) => {
      lines.push(`${pad}    ${JSON.stringify(frame)}${index === frames.length - 1 ? '' : ','}`);
    });
    lines.push(`${pad}  ]`);
  }

  lines.push(`${pad}}`);
  return lines;
}

/** `[x, y]`, spaced like every other coordinate in the format. */
function offset(point: PixelOffset): string {
  return `[${point.map((value) => JSON.stringify(value)).join(', ')}]`;
}

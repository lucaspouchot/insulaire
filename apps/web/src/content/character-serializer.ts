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
 * An **animation** follows the same rule with the *keyframe* as the unit: one
 * per line, frame and offset side by side, so "the body drops a pixel later in
 * the loop" is one changed line.
 *
 * ```json
 * "keyframes": [
 *   { "frame": 1, "offset": [0, -2] }
 * ]
 * ```
 *
 * What is dropped is what parses back to the value dropped: an empty `name`,
 * `helpKey`, `unit`, `options`, `min`, `max`, `step`, `showIf`, `when` or
 * `tint`, an absent `parent`, `parentAnchor` or `anchors`, a `step`
 * interpolation, and the whole `animations` list when a character has none.
 * `category` and `resolution` are always written — they are what the
 * file is *about*, and a reader should not have to know the defaults. `scope` is
 * never written: it belongs to the settings vocabulary and means nothing to a
 * character (`docs/adr/ADR-0029-characters-are-composed-sprites.md`).
 */

import {
  Animation,
  AnimationTrack,
  AttachmentPoint,
  CharacterDefinition,
  CharacterLayer,
  ControlDefinition,
  Keyframe,
  LayerVariant,
  PixelOffset,
  PixelRect,
} from './content-types';

/** The canvas a definition that names none is authored on. */
const DEFAULT_RESOLUTION = { width: 64, height: 128 };

/** How long a frame lasts when an animation names no duration. */
const DEFAULT_FRAME_DURATION_MS = 120;

/** The character file, in the canonical layout. */
export function serializeCharacter(character: CharacterDefinition): string {
  const lines = ['{', `  "id": ${JSON.stringify(character.id)},`];
  lines.push(`  "schemaVersion": ${JSON.stringify(character.schemaVersion)},`);
  if (character.name) {
    lines.push(`  "name": ${JSON.stringify(character.name)},`);
  }
  lines.push(`  "category": ${JSON.stringify(character.category ?? 'other')},`);
  const resolution = character.resolution ?? DEFAULT_RESOLUTION;
  lines.push(
    `  "resolution": { "width": ${JSON.stringify(resolution.width)}, ` +
      `"height": ${JSON.stringify(resolution.height)} },`,
  );

  lines.push('  "parameters": [');
  lines.push(...blocks(character.parameters ?? [], (parameter) => parameterLines(parameter, 4)));
  lines.push('  ],');

  lines.push('  "layers": [');
  lines.push(...blocks(character.layers ?? [], (layer) => layerLines(layer, 4)));
  const animations = character.animations ?? [];
  lines.push(animations.length > 0 ? '  ],' : '  ]');

  // Dropped entirely when there are none: a still character should not carry an
  // empty list saying it might have moved.
  if (animations.length > 0) {
    lines.push('  "animations": [');
    lines.push(...blocks(animations, (animation) => animationLines(animation, 4)));
    lines.push('  ]');
  }

  lines.push('}');
  return `${lines.join('\n')}\n`;
}

/** One parameter: the settings vocabulary, minus what a character ignores. */
function parameterLines(parameter: ControlDefinition, indent: number): string[] {
  const pad = ' '.repeat(indent);
  const entries: string[] = [
    `"id": ${JSON.stringify(parameter.id)}`,
    `"labelKey": ${JSON.stringify(parameter.labelKey)}`,
  ];
  if (parameter.helpKey) {
    entries.push(`"helpKey": ${JSON.stringify(parameter.helpKey)}`);
  }
  entries.push(`"control": ${JSON.stringify(parameter.control)}`);
  entries.push(`"default": ${JSON.stringify(parameter.default)}`);
  for (const bound of ['min', 'max', 'step'] as const) {
    const value = parameter[bound];
    if (typeof value === 'number') {
      entries.push(`"${bound}": ${JSON.stringify(value)}`);
    }
  }
  if (parameter.unit) {
    entries.push(`"unit": ${JSON.stringify(parameter.unit)}`);
  }

  const lines = [`${pad}{`, ...entries.map((entry) => `${pad}  ${entry},`)];

  const options = parameter.options ?? [];
  if (options.length > 0) {
    lines.push(`${pad}  "options": [`);
    lines.push(
      ...options.map(
        (option, index) =>
          `${pad}    { "value": ${JSON.stringify(option.value)}, ` +
          `"labelKey": ${JSON.stringify(option.labelKey)} }` +
          (index === options.length - 1 ? '' : ','),
      ),
    );
    lines.push(`${pad}  ],`);
  }

  if (parameter.showIf) {
    lines.push(
      `${pad}  "showIf": { "field": ${JSON.stringify(parameter.showIf.field)}, ` +
        `"equals": ${JSON.stringify(parameter.showIf.equals)} },`,
    );
  }

  return closeBlock(lines, pad);
}

/** One layer: a heading, where it hangs, its anchors, and its variants. */
function layerLines(layer: CharacterLayer, indent: number): string[] {
  const pad = ' '.repeat(indent);
  const variants = layer.variants ?? [];
  const lines = [`${pad}{`, `${pad}  "id": ${JSON.stringify(layer.id)},`];

  // A root layer writes no `parent`, and a layer hanging off its parent's
  // origin writes no `parentAnchor`: absent is the common case, and the common
  // case should be invisible in the file.
  if (layer.parent) {
    lines.push(`${pad}  "parent": ${JSON.stringify(layer.parent)},`);
  }
  if (layer.parentAnchor) {
    lines.push(`${pad}  "parentAnchor": ${JSON.stringify(layer.parentAnchor)},`);
  }

  const anchors = layer.anchors ?? [];
  if (anchors.length > 0) {
    lines.push(`${pad}  "anchors": [`);
    lines.push(
      ...anchors.map(
        (anchor, index) =>
          `${pad}    ${anchorLine(anchor)}` + (index === anchors.length - 1 ? '' : ','),
      ),
    );
    lines.push(`${pad}  ],`);
  }

  lines.push(`${pad}  "variants": [`);
  lines.push(
    ...variants.map(
      (variant, index) =>
        `${pad}    ${variantLine(variant)}` + (index === variants.length - 1 ? '' : ','),
    ),
  );
  lines.push(`${pad}  ]`, `${pad}}`);
  return lines;
}

/** One attachment point, on one line. */
function anchorLine(anchor: AttachmentPoint): string {
  return `{ "id": ${JSON.stringify(anchor.id)}, "at": ${offset(anchor.at)} }`;
}

/**
 * One animation: a heading and one block per track.
 *
 * The layout that matters here is the **keyframe**: one per line, frame and
 * offset side by side, so a diff of "the body drops a pixel later in the loop"
 * reads as exactly that.
 */
function animationLines(animation: Animation, indent: number): string[] {
  const pad = ' '.repeat(indent);
  const lines = [`${pad}{`, `${pad}  "id": ${JSON.stringify(animation.id)},`];
  if (animation.name) {
    lines.push(`${pad}  "name": ${JSON.stringify(animation.name)},`);
  }
  lines.push(`${pad}  "frames": ${JSON.stringify(animation.frames)},`);
  lines.push(
    `${pad}  "frameDurationMs": ${JSON.stringify(
      animation.frameDurationMs ?? DEFAULT_FRAME_DURATION_MS,
    )},`,
  );
  lines.push(`${pad}  "looping": ${JSON.stringify(animation.looping === true)},`);

  const tracks = animation.tracks ?? [];
  lines.push(`${pad}  "tracks": [`);
  lines.push(...blocks(tracks, (track) => trackLines(track, indent + 4)));
  lines.push(`${pad}  ]`);
  lines.push(`${pad}}`);
  return lines;
}

/** One track: the node it drives and its keyframes, one per line. */
function trackLines(track: AnimationTrack, indent: number): string[] {
  const pad = ' '.repeat(indent);
  const keyframes = track.keyframes ?? [];
  return [
    `${pad}{`,
    `${pad}  "node": ${JSON.stringify(track.node)},`,
    `${pad}  "keyframes": [`,
    ...keyframes.map(
      (keyframe, index) =>
        `${pad}    ${keyframeLine(keyframe)}` + (index === keyframes.length - 1 ? '' : ','),
    ),
    `${pad}  ]`,
    `${pad}}`,
  ];
}

/** A whole keyframe on one line; `step` is the default and is not written. */
function keyframeLine(keyframe: Keyframe): string {
  const entries = [
    `"frame": ${JSON.stringify(keyframe.frame)}`,
    `"offset": ${offset(keyframe.offset ?? [0, 0])}`,
  ];
  if (keyframe.interpolation && keyframe.interpolation !== 'step') {
    entries.push(`"interpolation": ${JSON.stringify(keyframe.interpolation)}`);
  }
  return `{ ${entries.join(', ')} }`;
}

/** `[x, y]`, spaced like every other coordinate in the format. */
function offset(point: PixelOffset): string {
  return `[${point.map((value) => JSON.stringify(value)).join(', ')}]`;
}

/** A whole variant on one line. */
function variantLine(variant: LayerVariant): string {
  const entries = [`"id": ${JSON.stringify(variant.id)}`];
  const when = variant.when ?? {};
  if (Object.keys(when).length > 0) {
    const conditions = Object.entries(when)
      .map(([id, value]) => `${JSON.stringify(id)}: ${JSON.stringify(value)}`)
      .join(', ');
    entries.push(`"when": { ${conditions} }`);
  }
  entries.push(`"rect": ${rect(variant.rect ?? [0, 0, 0, 0])}`);
  entries.push(`"sprite": ${sprite(variant)}`);
  return `{ ${entries.join(', ')} }`;
}

/** `[x, y, width, height]`, spaced like every other coordinate in the format. */
function rect(box: PixelRect): string {
  return `[${box.map((value) => JSON.stringify(value)).join(', ')}]`;
}

function sprite(variant: LayerVariant): string {
  const entries = [`"asset": ${JSON.stringify(variant.sprite.asset)}`];
  const tint = variant.sprite.tint;
  if (tint) {
    entries.push(
      `"tint": ${
        'fixed' in tint
          ? `{ "fixed": ${JSON.stringify(tint.fixed)} }`
          : `{ "parameter": ${JSON.stringify(tint.parameter)} }`
      }`,
    );
  }
  return `{ ${entries.join(', ')} }`;
}

/** Drops the trailing comma of whichever entry ended up last, and closes. */
function closeBlock(lines: string[], pad: string): string[] {
  const last = lines.length - 1;
  lines[last] = (lines[last] as string).replace(/,$/, '');
  return [...lines, `${pad}}`];
}

/** Renders a list of nested blocks, comma-separating them. */
function blocks<T>(items: readonly T[], render: (item: T) => string[]): string[] {
  return items.flatMap((item, index) => {
    const lines = render(item);
    if (index === items.length - 1) {
      return lines;
    }
    const last = lines.length - 1;
    return [...lines.slice(0, last), `${lines[last] as string},`];
  });
}

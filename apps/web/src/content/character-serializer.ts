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
 * geometry and visual all visible at once, which is what makes a diff of "the
 * hair moved up two pixels" readable.
 *
 * ```json
 * "variants": [
 *   { "id": "default", "rect": [0.4, 0.72, 0.2, 0.26], "visual": { … } }
 * ]
 * ```
 *
 * What is dropped is what parses back to the value dropped: an empty `name`,
 * `scaleParameter`, `helpKey`, `unit`, `options`, `min`, `max`, `step`, `showIf`
 * or `when`. `category` and `rendering` are always written — they are what the
 * file is *about*, and a reader should not have to know the defaults. `scope` is
 * never written: it belongs to the settings vocabulary and means nothing to a
 * character (`docs/adr/ADR-0028-character-definitions.md`).
 */

import {
  CharacterDefinition,
  CharacterLayer,
  ControlDefinition,
  LayerVariant,
  UnitRect,
} from './content-types';

/** The character file, in the canonical layout. */
export function serializeCharacter(character: CharacterDefinition): string {
  const lines = ['{', `  "id": ${JSON.stringify(character.id)},`];
  lines.push(`  "schemaVersion": ${JSON.stringify(character.schemaVersion)},`);
  if (character.name) {
    lines.push(`  "name": ${JSON.stringify(character.name)},`);
  }
  lines.push(`  "category": ${JSON.stringify(character.category ?? 'other')},`);
  lines.push(`  "rendering": ${JSON.stringify(character.rendering ?? 'procedural')},`);
  if (character.scaleParameter) {
    lines.push(`  "scaleParameter": ${JSON.stringify(character.scaleParameter)},`);
  }

  lines.push('  "parameters": [');
  lines.push(...blocks(character.parameters ?? [], (parameter) => parameterLines(parameter, 4)));
  lines.push('  ],');

  lines.push('  "layers": [');
  lines.push(...blocks(character.layers ?? [], (layer) => layerLines(layer, 4)));
  lines.push('  ]');

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

/** One layer: a heading and its variants, one per line. */
function layerLines(layer: CharacterLayer, indent: number): string[] {
  const pad = ' '.repeat(indent);
  const variants = layer.variants ?? [];
  return [
    `${pad}{`,
    `${pad}  "id": ${JSON.stringify(layer.id)},`,
    `${pad}  "variants": [`,
    ...variants.map(
      (variant, index) =>
        `${pad}    ${variantLine(variant)}` + (index === variants.length - 1 ? '' : ','),
    ),
    `${pad}  ]`,
    `${pad}}`,
  ];
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
  entries.push(`"rect": ${rect(variant.rect ?? [0, 0, 1, 1])}`);
  entries.push(`"visual": ${visual(variant)}`);
  return `{ ${entries.join(', ')} }`;
}

/** `[x, y, width, height]`, spaced like every other coordinate in the format. */
function rect(box: UnitRect): string {
  return `[${box.map((value) => JSON.stringify(value)).join(', ')}]`;
}

function visual(variant: LayerVariant): string {
  const drawn = variant.visual;
  if (drawn.kind === 'sprite') {
    return `{ "kind": "sprite", "asset": ${JSON.stringify(drawn.asset)} }`;
  }
  const color =
    'fixed' in drawn.color
      ? `{ "fixed": ${JSON.stringify(drawn.color.fixed)} }`
      : `{ "parameter": ${JSON.stringify(drawn.color.parameter)} }`;
  return `{ "kind": "shape", "shape": ${JSON.stringify(drawn.shape)}, "color": ${color} }`;
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

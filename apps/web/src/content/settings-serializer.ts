/**
 * Writes a {@link SettingsDefinition} back out as `content/settings.json`.
 *
 * `JSON.stringify(_, null, 2)` would work and would be unreadable: the engine
 * fills every optional field in before the editor ever sees a declaration, so a
 * naive round trip turns a six-line field into fifteen and puts `"min": null`
 * next to a toggle. A settings file is read and diffed by people, so this one
 * writes what an author would have written — fixed key order, one option per
 * line, and nothing that carries no information.
 *
 * The rule for omitting is the engine's own defaults (`crates/world/src/
 * settings.rs`): an absent `helpKey`, `unit`, `options`, `min`, `max`, `step`
 * or `showIf` parses back to exactly the value dropped here. `scope` is the
 * exception and is always written — it decides whether a player can move the
 * setting during a game, which is worth reading in the file rather than knowing
 * (`docs/adr/ADR-0025-settings.md`).
 */

import {
  ControlDefinition,
  SettingsDefinition,
  SettingsGroup,
  SettingsSection,
} from './content-types';

/** The settings file, in the canonical layout. */
export function serializeSettings(settings: SettingsDefinition): string {
  const lines = [
    '{',
    `  "id": ${JSON.stringify(settings.id)},`,
    `  "schemaVersion": ${JSON.stringify(settings.schemaVersion)},`,
    '  "sections": [',
    ...blocks(settings.sections, (section) => sectionLines(section, 4)),
    '  ]',
    '}',
  ];
  return `${lines.join('\n')}\n`;
}

function sectionLines(section: SettingsSection, indent: number): string[] {
  const pad = ' '.repeat(indent);
  return [
    `${pad}{`,
    `${pad}  "id": ${JSON.stringify(section.id)},`,
    `${pad}  "labelKey": ${JSON.stringify(section.labelKey)},`,
    `${pad}  "groups": [`,
    ...blocks(section.groups, (group) => groupLines(group, indent + 4)),
    `${pad}  ]`,
    `${pad}}`,
  ];
}

function groupLines(group: SettingsGroup, indent: number): string[] {
  const pad = ' '.repeat(indent);
  return [
    `${pad}{`,
    `${pad}  "id": ${JSON.stringify(group.id)},`,
    `${pad}  "labelKey": ${JSON.stringify(group.labelKey)},`,
    `${pad}  "fields": [`,
    ...blocks(group.fields, (field) => fieldLines(field, indent + 4)),
    `${pad}  ]`,
    `${pad}}`,
  ];
}

function fieldLines(field: ControlDefinition, indent: number): string[] {
  const pad = ' '.repeat(indent);
  const entries: string[] = [
    `"id": ${JSON.stringify(field.id)}`,
    `"labelKey": ${JSON.stringify(field.labelKey)}`,
  ];
  if (field.helpKey) {
    entries.push(`"helpKey": ${JSON.stringify(field.helpKey)}`);
  }
  entries.push(`"control": ${JSON.stringify(field.control)}`);
  entries.push(`"default": ${JSON.stringify(field.default)}`);
  for (const bound of ['min', 'max', 'step'] as const) {
    const value = field[bound];
    if (typeof value === 'number') {
      entries.push(`"${bound}": ${JSON.stringify(value)}`);
    }
  }
  if (field.unit) {
    entries.push(`"unit": ${JSON.stringify(field.unit)}`);
  }
  entries.push(`"scope": ${JSON.stringify(field.scope ?? 'session')}`);

  const lines = [`${pad}{`, ...entries.map((entry) => `${pad}  ${entry},`)];

  const options = field.options ?? [];
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

  if (field.showIf) {
    lines.push(
      `${pad}  "showIf": { "field": ${JSON.stringify(field.showIf.field)}, ` +
        `"equals": ${JSON.stringify(field.showIf.equals)} },`,
    );
  }

  // Whichever entry ended up last carries no comma.
  const last = lines.length - 1;
  lines[last] = (lines[last] as string).replace(/,$/, '');
  lines.push(`${pad}}`);
  return lines;
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

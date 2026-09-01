/**
 * The one writer of content files, and the one place a comma is decided.
 *
 * Every file under `content/` is read and diffed by people, so none of them is
 * `JSON.stringify(_, null, 2)`: a painted map would spread one placed tile over
 * four lines, and the engine fills every optional field in before the editor
 * sees a definition, so a naive round trip would write `"slot": ""` and
 * `"tags": []` on every potion in the game. What each kind wants instead is a
 * *layout* — a fixed field order, one record or one frame per line, and nothing
 * that says what leaving it out already says.
 *
 * That was seven hand-rolled printers, each with its own copy of three jobs:
 * where the commas go, how a value is spaced, and which fields to drop. This
 * module owns all three. A kind brings a {@link Shape}: the fields in the order
 * the file states them, how each is laid out, and when each is written. It
 * brings no defaults — those are generated from the Rust definitions
 * (`docs/adr/ADR-0012-shared-content-validation.md`), because "an absent
 * `stackSize` means `1`" is one fact and `crates/world/src/object.rs` is where
 * it is stated.
 *
 * ```ts
 * canonicalJson(
 *   blockOf(object, {
 *     absent: OBJECT_ABSENT,
 *     fields: {
 *       id: 'always',
 *       stackSize: 'unless-redundant',
 *       frames: { write: 'always', as: (frames) => list(frames.map(value)) },
 *     },
 *   }),
 * );
 * ```
 *
 * The document model is deliberately small — a value on one line, an object
 * over lines, an array one item to a line — because that is the whole of what
 * these formats do, and a writer that can express more could disagree with
 * itself about how a file looks.
 */

/** A value written on one line: `[4, 1]`, `"mountain"`, `{ "width": 16 }`. */
export interface Inline {
  readonly kind: 'inline';
  readonly text: string;
}

/** An object written over several lines, one member each. */
export interface Block {
  readonly kind: 'block';
  readonly members: readonly Member[];
}

/** An array written one item to a line. */
export interface List {
  readonly kind: 'list';
  readonly items: readonly Node[];
}

/** Anything this writer can lay out. */
export type Node = Inline | Block | List;

/** One member of an object: its key, and whatever it holds. */
export interface Member {
  readonly key: string;
  readonly value: Node;
}

/** What a field's value is once the definition is known to hold it. */
type Defined<Value> = Exclude<Value, undefined>;

/**
 * When a field is written.
 *
 * - `always` — even when it holds what an absent field would have meant, because
 *   it is what the file is *about* and a reader should not have to know the
 *   default.
 * - `unless-redundant` — dropped when it holds exactly what leaving it out
 *   already means, which is the common case and what keeps these files short.
 * - `when-present` — dropped when the definition does not hold it at all. For a
 *   document that states what it was given rather than what it means.
 * - `never` — belongs to another vocabulary and means nothing here, like
 *   `scope` on a character parameter.
 */
export type When = 'always' | 'unless-redundant' | 'when-present' | 'never';

/** A field that needs more than a name for when it is written or how. */
export interface FieldSpec<Definition, Key extends keyof Definition> {
  /** When it is written; a predicate for a rule only this kind knows. */
  readonly write?: When | ((definition: Definition) => boolean);
  /** How it is laid out. On one line, spaced like the rest, by default. */
  readonly as?: (value: Defined<Definition[Key]>, definition: Definition) => Node;
}

/** How one field is written. */
export type Rule<Definition, Key extends keyof Definition> =
  | When
  | FieldSpec<Definition, Key>;

/**
 * Every field of a definition, in the order the file states them.
 *
 * Exhaustive on purpose: a field added to the Rust definition shows up here as
 * a type error, so no content can be quietly dropped by a writer that never
 * heard of it.
 */
export type Fields<Definition> = {
  readonly [Key in keyof Definition]-?: Rule<Definition, Key>;
};

/**
 * What an omitted field means, as `crates/world/src/ts_export.rs` publishes it.
 *
 * Untyped values on purpose: these are compared, not consumed, and the table is
 * generated from Rust where the type is already checked. What this does pin is
 * the *keys* — a table entry that is not a field of the definition is a type
 * error here.
 */
export type Absent<Definition> = {
  readonly [Key in keyof Definition]?: unknown;
};

/** A kind's layout: what an absent field means, and how each one is written. */
export interface Shape<Definition> {
  readonly absent?: Absent<Definition>;
  readonly fields: Fields<Definition>;
}

/** The whole document, with the trailing newline every content file carries. */
export function canonicalJson(node: Node): string {
  return `${render(node, 0).join('\n')}\n`;
}

/** A value on one line, spaced the way these files are. */
export function value(held: unknown): Inline {
  return { kind: 'inline', text: text(held) };
}

/** An object on one line: `{ "at": [4, 1], "tile": "mountain" }`. */
export function row(members: readonly Member[]): Inline {
  if (members.length === 0) {
    return { kind: 'inline', text: '{}' };
  }
  const parts = members.map((member) => `${JSON.stringify(member.key)}: ${oneLine(member.value)}`);
  return { kind: 'inline', text: `{ ${parts.join(', ')} }` };
}

/** An object over several lines, or `{}` when it holds nothing. */
export function block(members: readonly Member[]): Node {
  return { kind: 'block', members };
}

/** An array one item to a line, or `[]` when it holds none. */
export function list(items: readonly Node[]): Node {
  return { kind: 'list', items };
}

/** One member, for a document assembled outside a {@link Shape}. */
export function member(key: string, held: Node): Member {
  return { key, value: held };
}

/** A definition as an object over several lines, in its shape's field order. */
export function blockOf<Definition extends object>(
  definition: Definition,
  shape: Shape<Definition>,
): Node {
  return block(membersOf(definition, shape));
}

/** A definition as an object on one line, in its shape's field order. */
export function rowOf<Definition extends object>(
  definition: Definition,
  shape: Shape<Definition>,
): Inline {
  return row(membersOf(definition, shape));
}

/**
 * The members a definition writes, in the order its shape states them.
 *
 * A field the definition does not hold is written as what an absent one means,
 * which is what makes `"kind": "other"` land in a file blocked out before its
 * author chose one. A field that means nothing either way — no value held and
 * none stated as absent — is left out rather than written as `undefined`.
 */
export function membersOf<Definition extends object>(
  definition: Definition,
  shape: Shape<Definition>,
): Member[] {
  const written: Member[] = [];

  for (const key of Object.keys(shape.fields) as (keyof Definition & string)[]) {
    const rule = shape.fields[key];
    const spec: FieldSpec<Definition, typeof key> = typeof rule === 'string' ? { write: rule } : rule;
    const when = spec.write ?? 'unless-redundant';
    if (when === 'never') {
      continue;
    }

    const held = definition[key];
    const absent = shape.absent?.[key];
    // `undefined` is the only way a definition says it holds nothing: `null` is
    // a value the format carries, and a characteristic that starts empty holds
    // exactly that.
    const stated = (held === undefined ? absent : held) as Defined<Definition[typeof key]> | undefined;

    if (typeof when === 'function') {
      if (!when(definition)) {
        continue;
      }
    } else if (when === 'when-present') {
      if (held === undefined) {
        continue;
      }
    } else if (when === 'unless-redundant') {
      if (!(key in (shape.absent ?? {}))) {
        throw new Error(
          `\`${key}\` is written unless it is redundant, but nothing says what an ` +
            'absent one would have meant. Publish it from `crates/world/src/ts_export.rs`.',
        );
      }
      if (same(stated, absent)) {
        continue;
      }
    }

    if (stated === undefined) {
      continue;
    }
    written.push({ key, value: spec.as ? spec.as(stated, definition) : value(stated) });
  }

  return written;
}

/** The lines of one node, indented by `indent` spaces. */
function render(node: Node, indent: number): string[] {
  const pad = ' '.repeat(indent);
  if (node.kind === 'inline') {
    return [`${pad}${node.text}`];
  }
  if (node.kind === 'list') {
    if (node.items.length === 0) {
      return [`${pad}[]`];
    }
    const items = node.items.map((item) => render(item, indent + 2));
    return [`${pad}[`, ...separated(items), `${pad}]`];
  }
  if (node.members.length === 0) {
    return [`${pad}{}`];
  }
  const members = node.members.map((entry) => memberLines(entry, indent + 2));
  return [`${pad}{`, ...separated(members), `${pad}}`];
}

/** The key, then whatever it holds, starting on the same line. */
function memberLines(entry: Member, indent: number): string[] {
  const [first, ...rest] = render(entry.value, indent);
  const opening = `${' '.repeat(indent)}${JSON.stringify(entry.key)}: ${(first as string).trimStart()}`;
  return [opening, ...rest];
}

/**
 * A comma after every block but the last.
 *
 * The whole of the rule the seven writers each restated, and the reason none of
 * them needs to end by stripping a comma off whichever line turned out last.
 */
function separated(blocks: readonly string[][]): string[] {
  return blocks.flatMap((lines, index) => {
    if (index === blocks.length - 1) {
      return lines;
    }
    const last = lines.length - 1;
    return lines.map((line, at) => (at === last ? `${line},` : line));
  });
}

/** A node's text when it is known to fit on one line. */
function oneLine(node: Node): string {
  return node.kind === 'inline' ? node.text : render(node, 0).map((line) => line.trim()).join(' ');
}

/**
 * Like `JSON.stringify`, but spaced the way these files are: coordinates read
 * as `[4, 10]` rather than `[4,10]`, and a nested record as `{ "surface": "f" }`
 * rather than `{"surface":"f"}`.
 */
function text(held: unknown): string {
  if (Array.isArray(held)) {
    return `[${held.map((item) => text(item)).join(', ')}]`;
  }
  if (isRecord(held)) {
    const parts = Object.entries(held)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => `${JSON.stringify(key)}: ${text(entry)}`);
    return parts.length === 0 ? '{}' : `{ ${parts.join(', ')} }`;
  }
  return JSON.stringify(held) ?? 'null';
}

/** Whether two JSON values are the same one, member by member. */
function same(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, at) => same(item, right[at]));
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = Object.keys(left).filter((key) => left[key] !== undefined);
    const others = Object.keys(right).filter((key) => right[key] !== undefined);
    return keys.length === others.length && keys.every((key) => same(left[key], right[key]));
  }
  return false;
}

function isRecord(held: unknown): held is Record<string, unknown> {
  return typeof held === 'object' && held !== null;
}

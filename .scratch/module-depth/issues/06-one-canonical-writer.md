# 06 — One canonical writer, not seven

Status: needs-triage
Strength: worth exploring
Blocked by: 03

## Problem

Seven modules under `apps/web/src/content/` write content files by string
concatenation, each with its own copy of the same three jobs — field order,
which defaults to omit, and where the commas go.

```
character-serializer.ts           363
world-serializer.ts               218
tile-set-serializer.ts            155
settings-serializer.ts            128
decoration-serializer.ts          127
object-serializer.ts              100
character-creation-serializer.ts   18   ← JSON.stringify, nothing else
```

The shape, from `object-serializer.ts:44`:

```ts
const lines = ['{', `  "id": ${JSON.stringify(object.id)},`];
if (object.name) { lines.push(`  "name": ${JSON.stringify(object.name)},`); }
if ((object.stackSize ?? 1) !== 1) { … }        // serde already knows this default
const last = lines.length - 1;
lines[last] = (lines[last] as string).replace(/,$/, '');   // comma fixup, ×7
```

Two problems, not one:

- The comma fixup and the field-emission loop are restated seven times.
- "Which defaults are omitted" is a **second copy** of the `#[serde(default)]` /
  `#[serde(skip_serializing_if)]` attributes on the Rust definitions. Two
  readings of one fact, in two languages.

`character-creation-serializer.ts` is the tell: 18 lines of `JSON.stringify`
against `character-serializer.ts`'s 363-line hand-rolled printer. "Serializer" is
not a uniform depth class here — a caller cannot know what one does without
opening it.

## Why the files are pretty-printed at all

Not incidental, and worth preserving. From `object-serializer.ts`:

> an object file is read and diffed by people, and a definition round-tripped
> through `JSON.stringify` would carry `"slot": ""` and `"tags": []` on every
> potion in the game […] The icon is a **flipbook**, one frame per line, so "the
> third frame of the glint changed image" is one changed line.

Whatever replaces the seven must keep one-frame-per-line and must keep dropping
what parses back to the value dropped.

## Deepening

One canonical-JSON writer module taking a field order and a default table. The
seven shrink to those tables. With ticket 03 in place, the tables are generated
from the serde attributes rather than written a second time.

An alternative worth costing during grilling: the writer moves to Rust, where the
defaults already live, and the editor asks the engine to render a definition.
That deletes the TypeScript writer entirely, at the cost of a seam crossing on
every save.

## Open questions

- TypeScript writer with a generated table, or Rust writer behind the seam?
- Does the table describe field order only, or also the per-kind layout rules
  (one frame per line, resolution on one line, a matrix in a block)?
- Seven spec files exist for the seven writers. Do they become one spec of the
  writer plus seven table fixtures?

## Done when

- One module decides where a comma goes.
- No default is stated in both Rust and TypeScript.
- The `content/` fixtures round-trip byte for byte.
- `npm run check` passes.

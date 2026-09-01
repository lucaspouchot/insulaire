# 06 — One canonical writer, not seven

Status: done
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

## Decisions

**A TypeScript writer with a generated table.** The Rust alternative was costed
and dropped: `serializeWorld` feeds `engine.loadWorld` at `play-page.ts:374` and
`map-editor-page.ts:1528`, so a writer behind the seam would serialise in Rust
in order to parse in Rust; the per-kind layout rules are presentation the play
runtime never needs and would carry in the WASM bundle; and a draft that fails
to deserialise could no longer be saved, which is exactly the blocked-out
content the editor exists to write.

**The table describes both** — field order *and* the per-kind layout. One rule
per field: `always`, `unless-redundant`, `when-present` or `never`, plus an
optional `as` that lays the value out (one frame per line, a record on one
line). That is what makes seven printers one module: the layout was never the
duplicated part, the commas and the defaults were.

**What an absent field means is generated, and the values are never retyped.**
`absent_values!` in `crates/world/src/ts_export.rs` names the *field*; a
definition parsed from the smallest document it accepts supplies the value, the
way `boundary_values!` names a constant and lets the compiler supply what it
holds. A renamed field is a compile error, a changed `#[serde(default = "…")]`
changes the table on the next generator run, and one test per entry proves the
published value is what omitting the field already means. Twenty tables, so the
mirror publishes 61 values where it published 41.

**The seven specs stay**, and the writer gets its own. Each spec still pins the
layout of one format, which is the fact it was testing; `canonical-json.spec.ts`
pins the comma, the spacing and the four rules once. Coverage did not move: it
grew by the two files that had none of it.

## Done when

- One module decides where a comma goes. ✔ `content/canonical-json.ts`; the
  seven are tables now. 738 lines of printing became 499 of table plus 175 of
  writer — the saving is small because a table is not free, and the point was
  never the line count: there is one answer where there were seven.
- No default is stated in both Rust and TypeScript. ✔ The two that were
  TypeScript-only — a character's `64×128` canvas and a 120ms frame, both
  retyped in `character-serializer.ts` — are gone with the rest.
- The `content/` fixtures round-trip byte for byte. ✔ Five did already; the
  sixth, `content/character-creation.json`, is now written by the same module
  and has the same test. It lost 96 lines and six `"nullable": false` keys that
  said what leaving them out already said.
- `npm run check` passes. ✔

Two files moved, both explained by the consolidation and both landing on the
copy that was wrong:

- `content/character-creation.json` — was `JSON.stringify(_, null, 2)`, the one
  content file written by a different rule.
- a world's `grid` and `reveal` — were `{"lineWidth":3}`, against the rule
  `world-serializer.ts`'s own documentation gave two paragraphs further up
  (`{ "surface": "f" }` rather than `{"surface":"f"}`). No shipped world states
  either, so no fixture moved; two spec expectations did.

One bug found on the way, in the same class as the one ticket 03 found: `??`
reads a `null` as absent, so a nullable characteristic's `"default": null` was
dropped by the first draft of the writer — from a *required* field, which would
have made the file fail to parse. `undefined` is now the only way a definition
says it holds nothing.

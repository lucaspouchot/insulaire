# 03 — Derive the content types from the definitions

Status: done
Strength: strong
Blocked by: —

## Problem

`apps/web/src/content/content-types.ts` is 1,320 lines and 85 exported types. It
is a hand-kept mirror of the Rust content definitions — the structs, the bounds
and the schema versions — and exactly one pair is asserted equal anywhere:

```ts
// apps/web/src/engine/engine-integration.spec.ts:154
expect(info.worldSchemaVersion).toBe(WORLD_SCHEMA_VERSION);
```

Everything else is on trust:

```rust
// crates/world/src/definition.rs:41,77
pub const WORLD_SCHEMA_VERSION: u32 = 6;
pub const MAX_ELEVATION: i32 = i8::MAX as i32;
```
```ts
// apps/web/src/content/content-types.ts:19,301
export const WORLD_SCHEMA_VERSION = 6;
export const MAX_ELEVATION = 127;
```

The same holds for `MAX_TILE_VARIANTS`, `MAX_ELEVATION_LEVELS`,
`MAX_TILE_IMAGE_SIZE`, `MAX_SPRITE_RESOLUTION`, `MIN`/`MAX_GRID_LINE_WIDTH`,
`MAX_REVEAL_RADIUS`, the nine `*_SCHEMA_VERSION` constants and every struct
shape. A bound that changes on one side and not the other produces content the
editor accepts and the runtime refuses — the exact failure ADR-0012 exists to
prevent, one level below where that ADR is looking.

The file is also nine unrelated schemas concatenated into one module — world,
tile set, project, title screen, settings, character, character creation,
decoration, object — each with its own `SCHEMA_VERSION`, even though the editors
that consume them are already separate modules.

## Deepening

Emit `content-types.ts` from the Rust definitions during `npm run wasm:build`,
one generated module per definition module. The file becomes build output, not
maintained source: not edited, not reviewed, and impossible to disagree with
itself.

## What this does not change

ADR-0012's rule stands word for word:

> TypeScript may check what it can *represent* (a tile id that is not in the
> palette, a position outside the grid), never what is *valid*.

This ticket makes *what TypeScript can represent* derive from Rust instead of
being retyped beside it. Validation stays exactly where it is.

## Decisions

**`ts-rs`, not `schemars`.** The derive sits on the definition structs
themselves, so nothing parses Rust and the compiler is the only authority on a
shape. It handles what this schema actually uses: `rename_all`, tagged and
untagged enums, fixed-size array newtypes, and — the reason it fits here —
`skip_serializing_if` becomes an optional field, which is the convention the
hand-written file already followed. Three overrides carry what the derive alone
could not say: `#[ts(optional)]` and `#[ts(optional = nullable)]` to tell the two
`Option` families apart, `#[ts(type = ...)]` for the free-form property bags, and
`#[ts(as = ...)]` for the settings-value narrowing.

**The bounds are published from Rust too**, by `crates/world/src/ts_export.rs`,
rather than walked by a build script. A table names each constant, so a rename
is a compile error; the value is rendered from the item; and a test refuses a
`pub const` in an exported module that is neither published nor explicitly held
back, so a bound cannot quietly stop crossing. Floats go through `Display`
rather than `serde_json`, which would widen `0.55f32` to `0.550000011920929`.

**Committed, with `--check` in the gate** — the `check:seam` contract. `cargo
test` writes into `target/ts-bindings` (gitignored, via `.cargo/config.toml`);
`scripts/generate-content-types.mjs` points both generators at a temporary
directory, assembles the modules, runs prettier and writes
`apps/web/src/content/generated/`. `npm run check:types` fails on a stale copy.

## What the derive found

Three disagreements, all of which had been invisible:

- **the same Rust shape rendered three ways.** `characterCreation?: ContentRef`,
  `min?: number | null` and `logo: TitleLogo | null` are all
  `#[serde(default)] Option<T>`. serde writes `null` and accepts absent for all
  three, so all three are now `?: T | null`.
- **74 fields marked optional that Rust wrote unconditionally.** The file was
  right about the format and the Rust was noisy about it, so those fields gained
  `skip_serializing_if`. Making them *required* instead would have put a validity
  rule in the type system — `object.nameKey` defaults to `""` and
  `validation.rs:3431` refuses it — which ADR-0012 forbids.
- **a live latent bug.** `rename_all` on an enum renames variants, not variant
  fields, so `CreationBlock::Text` asked for `text_key` while the editor and
  `docs/content-format.md` both say `textKey`. No shipped file carries a text
  block, which is why nothing caught it. Fixed with `rename_all_fields`, with a
  round-trip test.

## Where it did not reach

`WorldMetadata` flattens a `BTreeMap<String, Value>`, and `ts-rs` allows neither
`type` nor `inline` on a flattened field, so `serde_json/JsonValue.ts` is
generated beside the schema modules rather than folded into them.

Six functions stayed hand-written, in `content/tile-set-geometry.ts` and
`content/world-defaults.ts`: they are the tile geometry arithmetic, a deliberate
second implementation for the same reason ADR-0011 keeps the hex maths twice —
the renderer answers them per visible cell per frame and cannot cross the
boundary to do it. `content/setting-values.ts` holds the two aliases no Rust item
names.

## Done when

- Every type and bound in `content-types.ts` traces to a Rust item.
- A bound changed in Rust and nowhere else fails the TypeScript build.
- The nine schemas arrive as nine modules.
- The one hand-written assertion at `engine-integration.spec.ts:154` says what
  it is for: it is *not* redundant with `check:types`, which proves the
  committed bindings match `crates/world/src/`. It proves the `.wasm` being
  loaded was built from them, which is the one gap a generator cannot close.
- `npm run check` passes.

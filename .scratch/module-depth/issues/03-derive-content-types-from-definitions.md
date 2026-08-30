# 03 — Derive the content types from the definitions

Status: needs-triage
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

## Open questions

- `ts-rs` (derive on each struct, emits `.ts`) or `schemars` + a TS emitter?
  `ts-rs` is closer to the shape already written; `schemars` also gives the
  editor a JSON Schema, which nothing currently needs.
- Constants: `ts-rs` does not emit `const`. Does a small build script walk the
  `pub const` items, or do the bounds move into a struct that does get emitted?
- Does this run in `wasm:build`, or as its own `npm run types:build` that
  `wasm:build` calls? CI must fail if the checked-in output is stale — or the
  output is gitignored like `/apps/web/public/wasm/` already is.

## Done when

- Every type and bound in `content-types.ts` traces to a Rust item.
- A bound changed in Rust and nowhere else fails the TypeScript build.
- The nine schemas arrive as nine modules.
- The one hand-written assertion at `engine-integration.spec.ts:154` is
  redundant, and says so or goes.
- `npm run check` passes.

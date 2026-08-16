# ADR-0015 — Validate Content in the Engine, for Both Editor and Runtime

## Status
Accepted

## Context

ADR-0008 requires that the editor "must not implement a second version of game rules", and ADR-0006 requires that "the editor must validate broken references before export". Those two pull in opposite directions unless validation has a single home: the obvious shortcut is a convenient TypeScript check in the editor, which then drifts from what the runtime actually accepts. The result is the worst possible failure — a world the editor calls valid and the runtime refuses to load.

## Decision

There is exactly one validator, `hex_world::validate_world`, written in Rust.

- The **runtime** runs it inside `Engine::load_world`. A world is registered only if it has no errors.
- The **editor** runs it through WASM via `HexEngine.validateWorld(json)`, which validates without registering anything.

Both receive the same `ValidationReport`: a `valid` flag plus a list of issues, each with a stable `code`, a `severity`, a JSON-ish `path` such as `entities[3].at`, and a human message.

Errors block loading; warnings do not. A world with no monsters warns (`world.noMonsters`) but plays.

The editor's "Validate & Play" button calls the validator and refuses to navigate when the report has errors.

The guarantee is checked by tests rather than asserted: `crates/engine/tests/shipped_content.rs` loads the real files from `content/`, and `apps/web/src/engine/engine-integration.spec.ts` pushes a world through the editor's document model and serialiser into the real WASM engine.

## Consequences

Positive:
- "the editor approved it" and "the runtime accepts it" are the same statement;
- issue codes are stable enough for the UI to branch on and for tests to assert;
- a new validation rule is added in one place and both sides gain it;
- the editor gets precise paths to the offending value for free.

Negative:
- the editor needs the WASM engine loaded before it can validate. Editing itself degrades gracefully without it — only the Validate and Play buttons stop working, and the shell reports why.
- validation is a whole-world pass rather than incremental. At MVP map sizes this is immeasurable; a large map edited continuously would want an incremental path.

## Rule

Any check that decides whether content is loadable belongs to `hex_world::validation`. TypeScript may check what it can *represent* (a tile id that is not in the palette, a position outside the grid), never what is *valid*.

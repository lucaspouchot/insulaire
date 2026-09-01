# ADR-0012 — Validate Content in the Engine, for Both Editor and Runtime

## Status
Accepted

## Context

ADR-0016 requires that the editor "must not implement a second version of game rules", and ADR-0002 requires that "the editor must validate broken references before export". Those two pull in opposite directions unless validation has a single home: the obvious shortcut is a convenient TypeScript check in the editor, which then drifts from what the runtime actually accepts. The result is the worst possible failure — a world the editor calls valid and the runtime refuses to load.

## Decision

There is exactly one validator, `insulaire_world::validate_world`, written in Rust.

- The **runtime** runs it inside `Engine::load::<kinds::World>`, which is the same door every content kind loads through (ADR-0010). A world is registered only if it has no errors.
- The **editor** runs it through WASM via `InsulaireEngine.validateWorld(json)`, which validates without registering anything.

Both receive the same `ValidationReport`: a `valid` flag plus a list of issues, each with a stable `code`, a `severity`, a JSON-ish `path` such as `entities[3].at`, and a human message.

Errors block loading; warnings do not. A world with no monsters warns (`world.noMonsters`) but plays.

The editor's **Validate** and **Validate doors** buttons call the validator and report every issue in place.

The guarantee is checked by tests rather than asserted: `crates/engine/tests/shipped_content.rs` loads the real files from `content/`, and `apps/web/src/engine/engine-integration.spec.ts` pushes a world through the editor's document model and serialiser into the real WASM engine.

## Consequences

Positive:
- "the editor approved it" and "the runtime accepts it" are the same statement;
- issue codes are stable enough for the UI to branch on and for tests to assert;
- a new validation rule is added in one place and both sides gain it;
- the editor gets precise paths to the offending value for free.

Negative:
- the editor needs the WASM engine loaded before it can validate. Editing itself degrades gracefully without it — only the Validate buttons stop working, and the shell reports why.
- validation is a whole-world pass rather than incremental. At MVP map sizes this is immeasurable; a large map edited continuously would want an incremental path.

## What TypeScript may represent is derived, not retyped

The rule below draws a line between *representable* and *valid*, and until
`.scratch/module-depth/issues/03` the representable half was a 1,320-line
TypeScript file kept in step with the definitions by hand — nine schema
versions, every bound and 85 struct shapes, with exactly one pair asserted equal
anywhere. A bound that changed on one side and not the other produced content
the editor accepted and the runtime refused: this decision's own failure mode,
one level below where it was looking.

That half is now derived. `ts-rs` renders the shapes from the definition structs
and `crates/world/src/ts_export.rs` publishes the bounds with the values the
compiler resolved, into `apps/web/src/content/generated/`; `npm run check:types`
refuses a stale copy. This does not move the line — validation stays exactly
where this ADR put it, and no rule crossed. It removes the only way the two
sides could disagree about what a file may *contain*.

Where TypeScript sees a narrower type than Rust holds — a settings value is
`serde_json::Value` in Rust and a four-shape union in the editor — the narrowing
is declared in Rust as well, and reached through `#[ts(as = ...)]`, so the field
keeps its Rust type and neither parsing nor validation moves. What may *not* be
derived this way is a validity rule: `ObjectDefinition::name_key` defaults to
`""` and `validate_object` refuses an empty one, so marking it required in
TypeScript would move that error out of the validator. It stays optional, and
Rust keeps judging.

## Rule

Any check that decides whether content is loadable belongs to `insulaire_world::validation`. TypeScript may check what it can *represent* (a tile id that is not in the palette, a position outside the grid), never what is *valid*.

What TypeScript *can* represent is not written twice. It is derived from the Rust definitions, and a copy that disagrees with them fails the gate.

# 02 — Make the content kind a module

Status: needs-triage
Strength: strong
Blocked by: 05

## Problem

"Content kind" is a real concept this codebase repeats nine times — tile set,
world, locale, title screen, settings, character, decoration, object, character
creation — but it is nowhere a module. Each kind is hand-threaded through eight
places:

1. `crates/world/src/<kind>.rs` — the definition and its rules *(real behaviour)*
2. `crates/world/src/validation.rs` — `validate_<kind>` *(real behaviour)*
3. `crates/engine/src/registry.rs` — `load_<kind>` / `validate_<kind>_json`
4. `crates/engine/src/lib.rs` — `load` / `validate` / `<kind>` / `<kind>_ids` /
   `resolve` / `preview`
5. `crates/engine/src/json.rs` — the same, as strings
6. `crates/wasm/src/lib.rs` — the same, as bindgen
7. `apps/web/src/app/services/engine.service.ts` — the same, as TypeScript
8. `apps/web/src/content/<kind>-serializer.ts` + the workspace

Measured on `9aaf9d2`, which added two kinds — 64 files, +10,929 lines. The
forwarding alone:

```
json.rs           +352
registry.rs       +218
engine/lib.rs     +197
wasm/lib.rs       +147
engine.service.ts +124
engine.types.ts    +25
                 -----
                 1,063 lines before one rule was written
```

`ContentRegistry`'s interface is 43 public members, and nearly all of them are
`load_x` / `validate_x_json` / `x` / `x_ids` repeated per kind.

## Deepening

One `ContentKind` module in `insulaire-engine`. A kind declares four operations
and nothing else:

```
parse     json  -> Definition
validate  &Definition -> ValidationReport
resolve   id, params -> Resolved      (registered content)
preview   &Definition, params -> Resolved   (content being written)
```

The registry slot, the six seam methods and the manifest bookkeeping derive from
that declaration. `insulaire_world::validate_<kind>` stays exactly where it is —
this ticket does not move a single rule, it removes the threading around them.

## The pattern is already in the repo

`apps/web/src/app/services/content-library.ts` (130 lines) did this once, on the
Angular side, in the same commit that created the problem:

> A subclass says three things and nothing else: which manifest list it reads,
> how one file is registered with the engine, and how one is described for a
> picker.

The three library modules are ~43 lines each as a result. The deepening stops at
the Angular edge; the registry and the seam never got it.

## Relationship to the other tickets

- **Blocked by 05.** A kind that declares itself needs one module to declare
  itself *to*; today the manifest's shape is read directly by ten modules.
- **01 is its mechanical half.** Once a kind's six methods derive from a
  declaration, the transports for them should too. Either order works; doing 01
  first makes 02 smaller.
- **03 and 06** are the same move on the content model and its writer.

## What this does not change

ADR-0010's shape rules are untouched: this ticket makes "a new content kind
arrives as a predictable set of five methods" mechanical rather than manual,
which is what the ADR already says a kind *is*. ADR-0012 is untouched: validation
stays in `insulaire_world`, one implementation, used by editor and runtime.

## Open questions

- Trait with associated types, or a declarative macro? A trait makes `resolve`
  and `preview` awkward where their parameters differ per kind (a decoration
  takes a cell geometry, a character takes a role and a time).
- Do the four kinds that have no `resolve`/`preview` (tile set, world, locale,
  title screen) declare them as absent, or is there a smaller kind?
- Does the Angular half fold into `ContentLibrary`, or stay separate?

## Done when

- A kind is declared in one place per language, not eight.
- `ContentRegistry`'s interface no longer grows by four members per kind.
- Adding a tenth kind is a declaration and a definition module.
- `crates/engine/tests/shipped_content.rs` still loads the real `content/`.
- `npm run check` passes.

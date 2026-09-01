# 02 — Make the content kind a module

Status: done
Strength: strong
Blocked by: 05 (done)

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

## Decisions

Settled while implementing, and answering the questions the ticket left open:

- **Both, for different halves.** A **trait** — `ContentKind` in
  `crates/engine/src/kind.rs` — carries what a kind *does*: what it is called,
  what its files parse into, which validator judges it, which locale keys it
  names. A **macro** — `content_kinds!`, invoked once in `registry.rs` — carries
  the *list*: it writes the registry's fields, the shelf wiring and the reset
  that were per-kind boilerplate. Neither half is boilerplate on its own, and
  the trait alone would have left three places to touch per kind (a field, an
  impl, a line in `clear`).
- **`resolve` and `preview` are not part of the kind, and that is the finding.**
  The ticket proposed four operations. Only two of them generalise: a
  decoration resolves at a moment of an animation, a character against a
  customisation and a role, a settings declaration against a bag of values, and
  a tile set not at all. Their *arguments are what makes a kind that kind*, so
  each stays a method of its own on `Engine` and a row of its own in the seam.
  What generalises is `parse` / `validate` / read back / list — and that is
  where all the forwarding was.
- **The variation is the shelf, not the operation set.** A kind is `Many`, kept
  by id, or `One`, replaced by whatever loads next; that is the only axis, and
  it is what decides whether a caller gets `get`/`ids` or `only`. Nothing
  declares an operation "absent".
- **A locale file is not a content kind.** It has no id, it is keyed by language
  *and* namespace, several files merge into one bundle, and a key defined twice
  is a parse error rather than a validation issue. Forcing it through the trait
  would have cost more interface than it saved, so `ContentRegistry` keeps the
  locale door by hand — the same finding [09](09-tile-and-locale-do-not-fit-the-draft-set.md)
  made about the draft set, arrived at independently. The **project manifest**
  *is* one, on the `One` shelf: its validator is cross-kind, which is a fact
  about that validator and not about the kind.
- **The seam declares kinds too.** 01 left `seam.json` with four hand-written
  rows per kind. A row with a `kind` now expands into the methods that kind has,
  each forwarding to the generic engine method with the kind as its type
  parameter. 54 methods, 38 rows, 9 of them kinds.
- **The Angular half stays separate.** This ticket's own reading holds: the
  deepening already happened there in `ContentLibrary`, which is why the three
  library modules are ~43 lines each. What remains per kind on that side is
  `EngineService`'s typed door — hand-written by 01's decision, for 03's reason
  — and the serializers, which are 03's subject. Folding either into this ticket
  would have pulled 03 into 02.
- **No rule moved.** Every validator is still `insulaire_world`'s, called from
  the same place with the same arguments. The one asymmetry the old code had —
  a project load checks the title screen's, the creation's and every object's
  locale keys, but not a character's or the settings' — is preserved
  deliberately and now says so in prose, because making it uniform would newly
  fail a `loadProject` on content that loads today.
- **ADR-0010 was amended, not replaced.** "A new content kind arrives as a
  predictable set of methods" is what the ADR already said a kind is; the
  amendment records that it now arrives by declaration.

## Outcome

| | Before | After |
|---|---|---|
| `ContentRegistry` public members | 48 | 18, none of them per-kind |
| `Engine` public methods | 55 | 35 |
| Per-kind rows in `seam.json` | 25 | 9 |
| `registry.rs` + `lib.rs` | 2,789 lines | 2,577, of which 482 are the new `kind.rs` |

Adding a tenth kind is now: the definition module and its validator in
`insulaire_world` (the rules, which were never the problem), one row in
`content_kinds!`, one row in `seam.json`, the `###` sections, and the wiring in
`EngineService`. Nothing in `registry.rs`'s body, `lib.rs`, `json.rs`,
`wasm/lib.rs` or `engine.types.ts`.

## Done when

- [x] A kind is declared in one place per language, not eight — `content_kinds!`
      in `crates/engine/src/registry.rs`, plus one row in `seam.json` for the
      boundary. The TypeScript half was already `ContentLibrary`'s; see the
      decision above.
- [x] `ContentRegistry`'s interface no longer grows by four members per kind: it
      does not grow by *any* member per kind.
- [x] Adding a tenth kind is a declaration and a definition module.
- [x] `crates/engine/tests/shipped_content.rs` still loads the real `content/`.
- [x] `npm run check` passes, and the smoke run is clean: verdict `clean`, 75
      screens, every canvas distance 0.

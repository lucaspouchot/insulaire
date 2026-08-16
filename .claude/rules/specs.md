---
description: 'Keep the contract documentation in docs/ in sync with behaviour changes'
paths:
  - "crates/**/*.rs"
  - "apps/web/src/**/*.ts"
  - "content/**/*.json"
---

# Contract Docs Stay in Sync

This project's source of truth is not a functional spec directory — it is a small
set of **contract documents** in `docs/`, each describing one seam of the
architecture. They are what someone reads to use the engine without reading it,
so a behaviour change that leaves them stale is an incomplete change.

> This repository has **no `docs/spec/`**. The `maintain-project-specs` skill
> describes a different project's webapp specs (`ACC-`, `EVT-`, `ROO-` rules) and
> does not apply here — do not follow it.

## What to update when

| If your change touches | Update in the same change |
|---|---|
| Content types or validation (`crates/world/`) | `docs/content-format.md` — fields, defaults, issue codes |
| The engine facade, DTOs, commands or errors (`crates/engine/`, `crates/wasm/`) | `docs/wasm-api.md` — methods, payload shapes, error codes |
| `GameState`, entities, RNG or the editor document model | `docs/data-model.md` |
| Crate boundaries, a new crate, or the repository layout | `docs/architecture.md` |
| The tick pipeline's phases or their order | `docs/wasm-api.md` ("Tick contract") **and** ADR-0004 |
| Developer commands, prerequisites, or a new limitation | `README.md` |
| An architectural decision | A new ADR — use `/create-adr`, never edit a decision in place |

If a change spans several rows, update all of them.

## Rules

- **The docs are normative for the boundary.** `docs/wasm-api.md` and
  `docs/content-format.md` describe what callers may rely on. Changing a payload
  shape, a command, an issue code or a schema field without updating them is a
  silent breaking change.
- **Contradictions are bugs.** If the code you are changing contradicts a
  contract document or an ADR, stop and flag it — one of the two is wrong. Do
  not silently diverge, and do not "fix" the doc to match a change you have not
  justified.
- **Schema changes are versioned.** Adding an optional field with a `serde`
  default is backwards compatible. Renaming, removing, or redefining a field
  requires bumping `WORLD_SCHEMA_VERSION` / `TILE_SET_SCHEMA_VERSION` and saying
  so in `docs/content-format.md`.
- **Reference decisions by path.** Cite ADRs from code and docs as
  `docs/adr/ADR-0014-hex-coordinate-model.md` so the reference stays greppable
  and can be checked to still resolve.
- **Pure refactorings, styling and technical changes need no doc update.**

## Tests are the executable half of the contract

These pin behaviour the documents describe. A behaviour change should update
them in the same change, and a doc claim that no test defends is worth a test:

| Test | Pins |
|---|---|
| `crates/engine/src/json.rs` | Every boundary method, success and failure, incl. error codes |
| `crates/engine/tests/shipped_content.rs` | That the real files in `content/` still load and play |
| `apps/web/src/engine/engine-integration.spec.ts` | The real WASM build against the real content, through the TS types |
| `apps/web/src/content/world-serializer.spec.ts` | That an editor export is byte-identical to the checked-in world |

Run `npm run check` (clippy + rustfmt + both test suites) before calling a change
done.

# 07 — Spike: generate the engine service off the seam

Status: ready-for-agent
Strength: speculative
Blocked by: —
Card: 5

A **spike**, last in the program. It produces a decision, not necessarily code.

## Problem

`apps/web/src/app/services/engine.service.ts` is 671 lines and ~53 methods, each
a two-to-four-line forwarder: `this.parse<T>(() => this.engine().x(json))`. It
is the fifth hand-kept copy of the seam method list — `seam.json` +
`scripts/seam.mjs` generate the other four (`json.rs`, `wasm/lib.rs`,
`RawInsulaireEngine`, the `docs/wasm-api.md` table), and `EngineService` is
guarded by `unwiredMethods` but written by hand.

The first pass's ticket 01 deferred generating it: "each returns a typed value
(`LoadOutcome`, `ResolvedTileRender`) and marshals its arguments
(`JSON.stringify(choice)`, `ProjectionMode`), and those types are ticket 03's
subject. Generating it would have pulled 03 into 01."

**Ticket 03 has landed.** The types are in `content/generated/`. The deferral
reason is gone. Whether the deepening is worth it is this spike's question:
fact-finding put the non-trivial method count at ~15–19, and `seam.json` already
stores adapt-closures-as-data, so it may keep the file deep — or it may just
relocate ~18 bespoke marshalling snippets into JSON.

## The spike

A throwaway branch. Add marshalling descriptors to `seam.json` for **five
methods** spanning the hard cases, and generate those into `engine.service.ts`:

| Method | What its body does beyond a passthrough |
|---|---|
| `loadWorld` | nothing — the trivial baseline |
| `resolveCharacter` | splits a `pose` object into `animation` + `Math.max(0, Math.round(timeMs))`; default `values = {}` |
| `previewTileRender` | default params `base = 0, roll = 0, choice = {}`; `JSON.stringify(choice)` |
| `createGame` | `JSON.stringify(settings)`; default `settings = {}`; `this.running.set(this.instance?.hasGame() ?? true)` **after** the call |
| `terrainBuffer` | routed through `this.call()` not `this.parse()` — raw `Uint8Array`, no JSON |

## Acceptance criterion

Commit the real work **only if both hold**:

1. Each method's `seam.json` addition is **structured data** — a marshalling
   descriptor with named fields — not a code snippet embedded in a JSON string.
2. A reader can still tell what `EngineService` does for a given method
   **without opening the generator**.

If either fails: `EngineService` stays hand-written and keeps the
`unwiredMethods` guard. Record the permanent deferral as an amendment to
ADR-0010 (via `/create-adr`), delete the spike branch, and mark this ticket
`wontfix` with the reason.

## What stays hand-written either way

`ready()` / `initialise()`, the `call` / `parse` plumbing, the `hasGame` signal
and the `running.set()` wiring around `createGame` / `endGame` if the descriptor
cannot express the post-call mirror cleanly.

## Done when

- [ ] The five methods are generated on a spike branch.
- [ ] The two-part criterion is judged in writing, in this file under
      `## Answer`.
- [ ] Either the rest is generated and the guard retired, or ADR-0010 carries
      the amendment and the branch is gone.

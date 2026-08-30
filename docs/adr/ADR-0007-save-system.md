# ADR-0007 — Store Local Saves in IndexedDB

## Status
Accepted

## Context

The game must work without a backend (ADR-0009), so a save has to live on the
player's machine. `localStorage` is the obvious store and the wrong one: it is
synchronous, string-only, and capped at a few megabytes — a limit a world's
mutable state plus an RNG stream can plausibly reach, and one that fails by
throwing in the middle of saving.

A save also has to be a *state*, not a screenshot of the interface. Anything
derived from a component tree cannot be restored into a different one, which is
why `CLAUDE.md` requires that saves never depend on Angular component state.

## Decision

**Local saves are stored in IndexedDB.** It is asynchronous, structured, and
bounded by disk rather than by a few megabytes.

**A save holds mutable state and world modifications, not content.** Reference
content stays in the game's assets and is reloaded by id, so a save is small and
a repainted tile set does not invalidate one. A save carries:

```text
save format version   world id and world version   scenario id
current tick          RNG state                    player state
entity state          world modifications          scenario state
combat state, when applicable
```

**The engine serialises it.** The state belongs to Rust (ADR-0001), so producing
and restoring a save is an engine operation and the host only moves bytes.

**A save names the schema it was written against**, so a load can refuse a save
it cannot honestly restore rather than restoring it wrongly.

## Consequences

Positive:
- saving needs no server and no permission prompt;
- a save is a state at a tick, which the deterministic RNG makes exactly
  restorable (ADR-0008);
- content updates do not invalidate saves that only reference it by id.

Negative:
- **none of this is implemented.** The engine does not serialise `GameState` and
  no store exists. `SaveCatalogService` answers honestly that there are no saves,
  so the title screen's *Continue* is offered disabled with a reason rather than
  hidden (ADR-0021) — the shape is in place and the substance is owed;
- save migrations will be needed the first time the state shape changes, and
  pre-1.0 this repository's rule is to break rather than migrate — which stops
  being true the moment a real player has a save;
- IndexedDB is per browser profile, so a delivered executable shares one profile
  per machine and saves do not travel between machines;
- private browsing and cleared site data destroy saves silently.

## Rule

A save is produced and restored by the engine and contains no Angular state. It
stores mutable state and world modifications; anything reachable by content id is
referenced, never copied.

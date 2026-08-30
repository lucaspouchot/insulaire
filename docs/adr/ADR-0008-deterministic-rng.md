# ADR-0008 — Use Deterministic RNG

## Status
Accepted

## Context

The game is turn-based and must be reproducible for testing and debugging
(ADR-0003). Randomness is what breaks that if it is taken from the wrong place:
`Math.random()` has no seed and no state, so a run that produced a bug cannot be
run again, and a save cannot restore the stream the session was in.

There is a second reason it must belong to Rust. If the host draws a number and
passes it in, the host is making a rules decision, which is exactly the
separation ADR-0001 exists to keep.

## Decision

**The engine owns a deterministic, serialisable RNG.** The seed and the RNG state
are Rust's, held in `GameState`, advanced only by the tick pipeline.

**Browser `Math.random()` is never used for simulation.** A host may use it for
presentation — a shimmer, a particle — and never for anything the engine would
have to reproduce.

**A seed enters once, at `createGame`**, and travels with the session across a
map change (ADR-0014) so a door does not reset the stream.

**Content choices that look random are not.** A tile variant is a hash of the
cell's coordinates, not a draw from this stream (ADR-0026), so the picture a map
shows does not depend on how many dice the rules rolled before it was drawn.

## Consequences

Positive:
- identical initial state and identical actions produce identical results, which
  gives deterministic tests, exact bug reproduction, future replays and a save
  that restores a session rather than approximating one;
- a transcript of a session is a complete description of it, which is what the
  smoke run compares against a baseline;
- nothing on screen can perturb the simulation.

Negative:
- the RNG state has to be serialised in every save, and a change to the generator
  invalidates saves written by the old one;
- a rule that draws conditionally makes the stream position depend on branches,
  so two runs that differ once diverge from then on — deliberate, and worth
  knowing when reading a diverged transcript;
- anything wanting randomness in the host has to be careful it is genuinely
  presentation, because there is no compiler check for that.

## Rule

Every number the simulation's outcome depends on comes from the engine's seeded
generator. A host that needs a random value for a rule asks the engine for the
outcome, never for a number.

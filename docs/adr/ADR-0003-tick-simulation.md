# ADR-0003 — Use Discrete Tick-Based Simulation

## Status
Accepted

## Context

The world has to advance, and how it advances decides how testable the game is.
A real-time loop makes the state a function of wall-clock time, which is
irreproducible: the same inputs replayed do not produce the same world, so a bug
cannot be pinned to a state and a save cannot be trusted to restore one.

The game is turn-based, so there is no reason to pay that. What is needed instead
is a definition of *when* the world moves, and a fixed order for the systems that
move it — because systems resolving in an undefined order produce bugs that
depend on iteration order rather than on rules.

## Decision

**The simulation uses a monotonic tick counter, and every valid player action
advances it by one.**

A player action follows this pipeline:

```text
1. validation
2. application
3. immediate effect resolution
4. world-system tick
5. scenario progression
6. trigger/event resolution
7. observable state changes
```

**A rejected action does not consume a tick** unless an explicit game rule says
otherwise. Rejection is not an error: the state is untouched and the host is told
why (ADR-0010).

**The order is public behaviour.** Anything that resolves during a tick resolves
at a named phase, and adding a system means choosing its phase deliberately.

## Consequences

Positive:
- the game is reproducible: identical initial state plus identical actions gives
  an identical world, which is what makes deterministic tests, bug reproduction
  and future replays possible (ADR-0008);
- a save is a state at a tick, not a moment in time;
- there is one answer to "when did that happen", and it is a number.

Negative:
- the resolution order is a contract, so reordering phases is a behaviour change
  that can alter the outcome of an existing scenario;
- anything that genuinely wants continuous motion — a walk animation, a camera
  glide — cannot live in the simulation, and needs a presentation seam instead
  (ADR-0031);
- one action per tick means an action that should take longer has to be modelled
  as state rather than as duration.

## Rule

The tick is the only clock the simulation has. Nothing in the engine may read
wall-clock time, and nothing outside the pipeline above may change `GameState`.

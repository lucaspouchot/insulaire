# ADR-0001 — The Game Engine Is Rust/WASM and Owns the Game State

## Status
Accepted

## Context

Angular is well suited to interfaces, editors and orchestration. It is the wrong
place for a simulation: a game state living in component fields cannot be tested
without a DOM, cannot be saved without serialising the component tree, and
cannot survive a route change. A hex world may hold many thousands of tiles and
entities, and pathfinding, AI and combat over them are computationally
intensive.

Two candidates were weighed for the engine itself. **TypeScript** keeps one
language and one toolchain, and gives up native-speed simulation, a strict type
system over packed data, and the option of running the engine anywhere but a
browser. **Rust compiled to WebAssembly** costs a build step and a boundary that
has to be designed, and buys all three.

## Decision

**Angular does not own simulation state.** `GameState` and every game rule
belong to the engine. Angular renders, orchestrates and authors; it asks the
engine questions and dispatches commands, and it never computes an answer the
engine could give.

**The engine is Rust, compiled to WebAssembly.** It owns world simulation, tick
processing, pathfinding, AI, combat, the game rules, the deterministic RNG
(ADR-0008) and non-graphical runtime generation.

**The two communicate through one explicit API**, shaped as commands in and
compact snapshots out (ADR-0010). The boundary is a designed contract, not an
exported object graph.

## Consequences

Positive:
- the simulation is testable without a browser, under ordinary `cargo test`;
- the engine can be reused outside this application;
- Angular carries interface work only, which is what it is good at;
- state survives navigation, because no component owns it (ADR-0023).

Negative:
- a JS/WASM boundary has to be maintained, and every piece of information the UI
  needs is a deliberate addition to it;
- the build gains `wasm-pack` and a second toolchain;
- a crossing per tile would be unaffordable, so the API must favour commands and
  packed buffers over many small calls — a constraint on every future addition,
  not a one-time cost.

## Rule

An Angular component must never directly mutate game state owned by the engine,
and must never re-implement a rule the engine already decides.

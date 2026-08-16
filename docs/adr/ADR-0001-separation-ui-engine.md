# ADR-0001 — Separate the UI from the Game Engine

## Status
Accepted

## Context

Angular is well suited for UI and editor workflows, but the game may contain many tiles and entities. The simulation must also be testable independently from the browser DOM.

## Decision

Angular does not own simulation state. The GameState and game rules belong to the Rust/WASM engine.

Angular communicates with the engine through an explicit API.

## Consequences

Positive:
- better testability
- simulation independent of the DOM
- less pressure on Angular
- possible reuse of the engine in other environments

Negative:
- a JS/WASM boundary must be maintained
- data transfer APIs must be designed carefully

## Rule

An Angular component must never directly mutate critical game state owned by the engine.

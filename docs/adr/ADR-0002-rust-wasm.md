# ADR-0002 — Use Rust Compiled to WebAssembly for the Game Engine

## Status
Accepted

## Context

Simulation, pathfinding, AI and combat are computationally intensive and should remain independent from the UI.

## Decision

The engine is written in Rust and compiled to WebAssembly for browser execution.

Rust owns:
- world simulation
- tick processing
- pathfinding
- AI
- combat
- game rules
- deterministic RNG
- non-graphical runtime generation

## Consequences

The engine must minimize JS/WASM boundary crossings. APIs should favor commands and controlled snapshots/diffs instead of thousands of individual calls.

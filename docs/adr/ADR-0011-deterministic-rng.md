# ADR-0011 — Use Deterministic RNG

## Status
Accepted

## Context

The game is turn-based and should be reproducible for testing and debugging.

## Decision

The engine owns a deterministic, serializable RNG.

The seed and RNG state are controlled by Rust.

Browser `Math.random()` is never used for simulation.

## Consequences

Given identical initial state and identical player actions, the simulation should produce identical results.

This enables:
- deterministic tests
- bug reproduction
- future replays
- easier debugging

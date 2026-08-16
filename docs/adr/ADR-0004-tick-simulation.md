# ADR-0004 — Use Discrete Tick-Based Simulation

## Status
Accepted

## Context

Every valid player action advances the world by one tick.

## Decision

The simulation uses a monotonic tick counter.

A player action follows this pipeline:

1. validation
2. application
3. immediate effect resolution
4. world-system tick
5. scenario progression
6. trigger/event resolution
7. observable state changes

A rejected action does not consume a tick unless an explicit game rule says otherwise.

## Consequences

The game becomes easier to test, reproduce and reason about.

Systems must have a stable, documented resolution order.

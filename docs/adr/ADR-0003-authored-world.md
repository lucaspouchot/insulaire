# ADR-0003 — Use Authored, Data-Driven Worlds

## Status
Accepted

## Context

The world is not procedurally generated. The map, locations, important entities and scenario elements must be designed by the author using an editor.

## Decision

The map is explicit, authored and versioned content.

Procedural terrain generation is not a runtime responsibility.

A seed may exist for simulation RNG, but it does not determine world geography.

## Consequences

Worlds can be:
- saved
- versioned with Git
- edited visually
- validated automatically
- distributed as content assets

The engine loads a `WorldDefinition`.

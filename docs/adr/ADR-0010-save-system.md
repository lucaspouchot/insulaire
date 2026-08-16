# ADR-0010 — Store Local Saves in IndexedDB

## Status
Accepted

## Context

The game must work without a backend.

## Decision

Local game saves are stored in IndexedDB.

A save contains:
- save format version
- world ID
- world version
- scenario
- current tick
- player state
- world modifications
- entity state
- scenario state
- combat state when applicable
- RNG state

## Consequences

Save migrations must be supported.

Reference content remains in the game assets; saves primarily store mutable state and world modifications.

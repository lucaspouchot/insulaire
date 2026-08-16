# ADR-0008 — Build the World Editor with Angular

## Status
Accepted

## Context

The authored world needs a level editor similar in spirit to RPG Maker, but based on a hexagonal grid.

## Decision

The editor is built with Angular and reuses the same content definitions as the runtime.

Initial features:
- new/open world
- hex-grid canvas
- terrain painting
- layers
- entity placement
- location/POI placement
- selection
- copy/paste
- undo/redo
- asset import
- tilesets
- gameplay tags
- preview
- validation
- export

The editor must not implement a second version of game rules.

## Consequences

Editor-specific models may be richer than runtime models when needed for editing workflows. The editor exports validated runtime definitions.

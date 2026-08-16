# ADR-0009 — Use Local Assets and Composable Tilesets

## Status
Accepted

## Context

Authors must be able to add their own textures, sprites and other visual assets.

## Decision

Assets use stable IDs.

A tileset describes:
- source image
- cell size
- sprite/region definitions
- tags
- rendering metadata

World tiles reference a `tileId`, not an arbitrary file path.

The runtime resolves IDs to loaded resources.

## Consequences

Renaming a source file does not break a map as long as the asset ID remains stable.

The editor must provide asset import and validation.

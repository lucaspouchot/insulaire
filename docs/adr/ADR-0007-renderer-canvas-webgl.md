# ADR-0007 — Render the World Through Canvas/WebGL

## Status
Accepted

## Context

A hex map can contain far more tiles than should be represented in the DOM.

## Decision

The game world is rendered to a Canvas using GPU acceleration.

Angular manages HUD and application interfaces, not a component hierarchy representing every hex.

The renderer uses:
- viewport culling
- texture caching
- batching
- texture atlases where useful
- level-of-detail techniques if required

## Consequences

Rendering is decoupled from the DOM.

User input is converted to hex coordinates and sent to the engine.

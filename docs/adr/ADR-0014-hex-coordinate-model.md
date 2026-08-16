# ADR-0014 — Use Odd-R Offset Coordinates for Content and Axial Internally

## Status
Accepted

## Context

A hex grid can be addressed several ways, and the choice leaks into content files, the editor, the renderer and the engine at once. Cube/axial coordinates make distance and neighbour maths trivial but describe a rhombus, which is awkward to author and validate. Offset coordinates describe a rectangle, which is what an author actually draws, but make arithmetic error-prone.

Rendering adds a third need — pixels — which depends on camera, zoom and device pixel ratio, and must not reach the engine.

## Decision

**Pointy-top hexagons, odd-r offset layout.** Rows run horizontally, `row` increases downwards, odd rows are shifted half a hex to the right.

Three coordinate spaces with fixed responsibilities:

| Space | Form | Where it lives | Used for |
|---|---|---|---|
| Offset | `[col, row]` | content files, engine boundary, editor | authoring, storage, bounds, the packed terrain buffer |
| Axial | `(q, r)`, `s = -q - r` | inside the engine, inside the renderer | distance, neighbours, rounding |
| Pixel | `(x, y)` | TypeScript renderer only | drawing, hit-testing |

Conversion between offset and axial is exact and lossless, and is implemented twice — `crates/world/src/hex.rs` and `apps/web/src/core/hex/hex-coords.ts` — with the same properties asserted on both sides.

**Hex ↔ pixel conversion exists only in TypeScript** (`apps/web/src/core/hex/hex-layout.ts`). The engine has no notion of pixels.

The six neighbour directions have a **canonical order**: E, NE, NW, W, SW, SE. This order is public engine behaviour, because rules that choose between equivalent neighbours break the tie by lowest direction index.

## Consequences

Positive:
- authored files are a plain rectangle: `width`, `height` and `[col, row]`;
- the packed terrain buffer is row-major offset, so buffer index, file coordinate and screen position all agree;
- the engine stays free of presentation concerns and testable without a DOM;
- deterministic tie-breaking has a single documented source.

Negative:
- the offset↔axial conversion is implemented in two languages and must not drift. Mitigated by mirrored test suites: the TypeScript tests assert the same round trips and the same odd-r shift as the Rust ones.
- only `pointy` orientation is implemented. `flat` is present in the schema and rejected by validation, so adding it later is a content-format extension rather than a breaking change.

## Rule

Coordinate *transforms* may exist in TypeScript. Coordinate-based *rules* — adjacency for legality, passability, occupancy — may not; they belong to the engine.

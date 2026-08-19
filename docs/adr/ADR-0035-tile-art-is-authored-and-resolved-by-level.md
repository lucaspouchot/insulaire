# ADR-0035 — Tile Art Is Authored per Level and Resolved, Never Transformed

## Status
Accepted

## Context

Until now a tile was a colour. `TileVisual` carried a `visualId` the renderer
was free to resolve into a texture, and nothing ever registered one, so every
map on screen was `fill()` on a polygon (ADR-0009, ADR-0007). Elevation made
that worse rather than better: an isometric tile is a top face plus the sides
the drop exposes, and both were the same flat colour with a shade over the
sides (ADR-0016).

Making that pixel art raises three questions that have wrong answers ready to
hand.

**How are the side faces made?** The cheap answer is to draw one face and
mirror or rotate it into the others. It is also the answer that ruins the art:
a mirrored rock face reads as a mirrored rock face, and the whole reason to
draw a tile by hand is that its south-west corner can be shadow and its
south-east corner moss. Any automatic transform of pixel art also resamples it
somewhere, which is the failure ADR-0029 exists to prevent.

**How tall can a tile be?** A cliff of a hundred steps cannot be a hundred
images, and clamping relief to however many images an author drew would make
`elevation` — a signed byte since ADR-0016 — a lie.

**Whose geometry wins?** The renderer's projection is two constants
(`tilt = 0.55`, `elevationStep = 0.15 × size`, ADR-0016) chosen when nothing
had been drawn. An image drawn to a different aspect ratio is stretched into
them, and a tile drawn from an image and a tile filled with colour then
disagree about what a hexagon looks like on the same map.

Two shapes were rejected. **A sprite sheet with named regions** — top, SW, SE —
puts the composition in the engine and re-raises the transform question every
time a face is missing. **A texture registered against `visualId`**, which the
sprite registry already supports, draws a flat tile and has nowhere to put
relief at all.

## Decision

**A tile carries `art`: surface variants and a ladder of elevation levels.**

**A cell's top face always comes from its surface variants, at every height.**
An elevation image is the **faces alone** — the two a pointy-top hexagon
exposes, drawn by hand — and never a copy of a top face it would only be
covered by. Its first row is the hexagon's lower shoulder line, so its top
`shoulderDepth` rows are the `V` those edges cut and everything below is face.
Raising a tile therefore costs it nothing: a cliff of grass still rolls the same
eight grass surfaces its flat neighbours do.

Nothing rotates, mirrors, skews or scales any part of an image to produce
another part. The only thing resolution does to an image is choose it and say
how far **down** it is drawn: onto the hexagon's lower shoulder line — three
quarters of the way down the top face, not a quarter — and then `drop` steps
below that.

**Colour goes behind whatever art does not cover.** A tile may author a top face
and no cliff at all, and a drop may run past the layer cap; in both cases the
cell fills its faces with `fallbackColor` and blits the art it has over them.
Suppressing the fill because *something* was authored is what leaves a raised
cell hanging over a hole.

```text
TileDefinition + elevation + variant roll ──> resolve() ──> ResolvedTileRender
```

**Levels above the last explicit one are produced by a rule, not by art.**
`ElevationRepeat` is `{ "level": n }` — reuse one — or `{ "pattern": [a, b] }` —
cycle several; absent reuses the highest explicit level. A cell of height *h*
standing over a base of *b* resolves to `h − b` layers, each the whole image
moved down `drop × elevationStep` pixels. Ten steps of cliff cost two images.

**The authored pixel grid is the authority on the projection.** A tile set
declares `art { width, surfaceHeight, elevationHeight, elevationStep }`, and
`Projection` derives its tilt and step from it: a surface image *is* the
projected top face's bounding box, and one authored step *is* one level of
relief. This replaces ADR-0016's two constants as the source of those numbers;
its transform, its invertibility and its per-row draw order are untouched, and
every consumer still asks `Projection`, so hit-testing, culling and the wall
bases keep working by construction.

**Resolution is implemented twice, and pinned.** Rust owns the model, the
validator and `resolve_tile_render`; TypeScript mirrors the resolver in
`apps/web/src/renderer/tile-art.ts`, because it runs once per visible cell per
frame and one WASM crossing per tile is what `CLAUDE.md` forbids. This is
ADR-0014's precedent, with ADR-0014's obligation: mirrored unit tests on both
sides, plus `engine-integration.spec.ts` comparing the mirror against the real
WASM build over a grid of heights and rolls.

**A variant is rolled, never randomised.** `variant_roll(col, row, tileId)` is
FNV-1a — a hash, not an RNG — so a cell answers the same thing every frame and
every session, no seed travels with the map, and a stack varies its face down
the column by rolling with the level as well as the cell.

**The asset editor is the tool, and its preview is the renderer.** It browses by
category so that objects and decorations are entries rather than new screens;
it draws its preview through `HexLayout`, `Projection` and the same resolver;
and it paints the images through `SpriteDocument`, which grew a flood fill, a
movable rectangular selection and an alpha for this. The alpha is the one thing
ADR-0030 rules out for a **character** — a soft edge survives its tint pipeline
as a fringe no recolouring can fix — and a tile is blitted as it stands, so a
shoreline that fades is allowed here and nowhere else.

## Consequences

Positive:

- an artist owns every visible pixel of a raised tile, including the difference
  between its two faces, which is the point of authoring pixel art at all;
- surfaces and faces vary independently: eight tops and three courses is
  twenty-four looks per height, from eleven images, and no image is drawn only
  to be hidden;
- relief is unbounded in height and bounded in cost: `MAX_STACKED_LEVELS` caps
  the blits, and the art a hundred-step cliff needs is the art a two-step cliff
  needs;
- a map still stores a tile id, so repainting art never touches a world file
  (ADR-0009), and the tile set is validated by the same Rust the runtime loads
  with (ADR-0015);
- the preview cannot drift from the game, because it is not a second
  implementation of anything.

Negative:

- **this engine's hexagons are pointy-top** (ADR-0014), whose silhouette has two
  lower edges meeting at a south vertex. A raised tile therefore exposes a
  south-west and a south-east face — not the three a flat-top layout would — and
  the editor's guides say so. A flat-top layout would give three, and is already
  rejected by validation;
- **an elevation image is an awkward height**: `surfaceHeight / 4 + step`,
  because it has to hold the `V` before it can hold a face. The alternative —
  a full-canvas image with a transparent top — is a rounder number and wastes
  most of its pixels, and would let a face image quietly paint over a top face
  it is not supposed to own;
- **the shipped worlds look different.** Deriving the projection from the
  default grid (32 wide, 20 of surface, step 8) makes one level of relief 0.43
  hex-widths instead of ADR-0016's 0.15, so existing isometric maps gain visibly
  deeper cliffs. The number is now a field in a content file, which is where it
  should have been;
- **resolution exists in two languages** and must not drift. Mitigated exactly
  as ADR-0014 mitigates the hex maths, and the integration test makes a
  divergence a red build rather than a wrong picture;
- the camera zooms freely, so a tile is only pixel-for-pixel exact at the zoom
  its grid was drawn for. Smoothing is off everywhere, so it stays hard-edged
  rather than blurred; the **editor** keeps the whole-number zoom, because that
  is where a click has to land on the pixel it points at;
- `TILE_SET_SCHEMA_VERSION` is `2`. Every field is defaulted, so a `1` file
  still parses and draws its colours, but the shipped files say `2`;
- autotiling, terrain transitions and animated tiles are **not** implemented.
  The shape leaves room for them — resolution already takes a cell and returns a
  list of images — and nothing here should be taken as having designed them.

## Rule

No part of a tile's art may be produced from another part, and no elevation
image may carry a top face. Resolution chooses an image and offsets it
vertically; a rotation, a mirror, a skew or a non-integer scale of tile art is a
bug, and a face that needs to differ is a face an artist draws.

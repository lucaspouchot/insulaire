# ADR-0026 — Tile Art Is Authored per Band and Resolved, Never Transformed

## Status
Accepted

## Context

A tile used to be a colour: `visualId` was never registered against anything, so
every map on screen was `fill()` on a polygon. Elevation made that worse rather
than better — an isometric tile is a top face plus the sides the drop exposes,
and both were the same flat colour with a shade over the sides (ADR-0013).

Making that pixel art raises questions with wrong answers ready to hand.

**How are the side faces made?** The cheap answer is to draw one face and mirror
or rotate it into the others, and it ruins the art: a mirrored rock face reads as
a mirrored rock face, and the point of drawing a tile by hand is that its
south-west corner can be shadow and its south-east corner moss. Any automatic
transform of pixel art also resamples it somewhere.

**How tall can a tile be?** A cliff of a hundred steps cannot be a hundred
images, and clamping relief to however many images an author drew would make
`elevation` — a signed byte — a lie.

**Whose geometry wins?** The renderer's projection was two constants chosen when
nothing had been drawn. An image drawn to a different aspect ratio is stretched
into them, and a tile drawn from an image then disagrees with a tile filled with
colour about what a hexagon looks like on the same map.

**Which picture does a cell show?** A hash of the coordinates is the right
default and the wrong absolute: an author who wants the flowered grass at the
mouth of a valley has no way to say so, and the only workaround buys a palette
entry, a movement cost and a terrain family to express a choice of picture.

**And which view is it drawn for?** The two projections do not show the same
shape — a surface image is the projected top face's bounding box, so blitted into
a top-down map it covers the top 40 rows of a 74-row hexagon and leaves the rest
bare. Stretching it to fit squashes a drawing composed for a different outline.

Two shapes were rejected outright. **A sprite sheet with named regions** puts the
composition in the engine and re-raises the transform question every time a face
is missing. **A texture registered against `visualId`** draws a flat tile and has
nowhere to put relief at all. A per-cell **layer index** was rejected too: it
would put the renderer's data model in the map file, and inserting a variant
would silently repaint every cell naming an index below it.

## Decision

**A tile carries `art`: flat variants, surface variants, and a ladder of
elevation levels.** A tile set declares one pixel grid for all of them —
`art { width, surfaceHeight, flatHeight, elevationHeight, elevationStep }` — and
`Projection` derives its tilt and step from it, replacing ADR-0013's two
constants as the source of those numbers. Its transform, invertibility and
per-row draw order are untouched, and every consumer still asks `Projection`.

**The projection chooses the list, and the two never mix.** A top-down world
draws `flat` alone and shows no relief; an isometric world draws `surface` plus
its elevation layers. A tile with no art for the projection in play draws its
`fallbackColor` — never a picture belonging to the other view, because a wrong
picture reads as a bug in the art and a flat colour reads as art not yet drawn.

**A cell's top face always comes from its surface variants, at every height.**
An elevation image is the faces alone — the two a pointy-top hexagon exposes,
drawn by hand — never a copy of a top face it would only be covered by. Raising a
tile therefore costs it nothing.

**The faces are a band, not the rest of the canvas.** An elevation image's first
row is the hexagon's lower shoulder line, so its top `shoulderDepth` rows are the
`V` those two edges cut; under that it holds a band filling the rest of the
canvas — `elevationHeight − shoulderDepth` rows — whose lower edge repeats the
same `V`. The last of a stack ends on the hexagon's own outline rather than on a
flat cut, and its four corners are never drawing room.

**A cliff is stacked in whole bands, from its foot.**

```text
  bandLevels = max(1, floor(faceHeight / elevationStep))
  layers     = ceil((h − b) / bandLevels)          capped at MAX_STACKED_LEVELS
  level(n)   = max(1, floor(b / bandLevels) + n)   n from the foot, 1-based
  drop(n)    = (h − b) − n × bandLevels            in steps, signed
```

The band an artist draws and the distance a level lifts a cell are two numbers,
not one. `elevationStep` is the lift; `elevationHeight − shoulderDepth` is the
band. One image is drawn per band, so the art is shown whole and a cliff is still
exactly `(h − b) × elevationStep` pixels tall — where one image per *level* showed
the same slice of the same picture over and over. Stacking from the foot makes
the lowest band's lower edge the cell's silhouette at every height; the topmost
band may then start above the top face, which is drawn last and covers it, so
`drop` is signed. `bandLevels = 1` is one image per level, layer for layer.

**Which ladder level a band draws is its index from the ground**, not its height,
so strata line up across a map.

**Levels above the last explicit one are produced by a rule, not by art.**
`ElevationRepeat` is `{ "level": n }` or `{ "pattern": [a, b] }`; absent reuses
the highest explicit level. Ten steps of cliff cost two images.

**Nothing rotates, mirrors, skews or scales any part of an image to produce
another part.** Resolution chooses an image and says how far down it is drawn.

**Colour goes behind whatever art does not cover.** A tile may author a top face
and no cliff, and a drop may run past the layer cap; in both cases the cell fills
its faces with `fallbackColor` and blits the art it has over them. Suppressing
the fill because *something* was authored is what leaves a raised cell hanging
over a hole.

**A placed cell may choose its art: `{ surface?, elevationTile?, elevation? }`,
all by id, all optional.** Absent — which is what nearly every cell says — the
roll decides. `elevationTile` names the tile whose ladder cuts the faces and
nothing else, so grass on top and rock underneath comes from art that already
exists. `elevation` absent means "the variant the surface took", so a cliff reads
as one cut through one hillside rather than as courses of masonry. One chosen
index serves both views, wrapping when the two lists differ in length.

**Ids, not indices**, and the search happens once when `WorldGrid` flattens the
map — never in a draw call. A dangling reference costs a cell its choice, not its
picture: it falls back to the roll, and validation reports it as a **warning**.
Painting a cell drops its choice, because `grass_f` means nothing on sand.

**The block is presentation.** `art` on a placed tile may not change terrain,
cost, tags or passability, and no rule reads it.

**A variant is rolled, never randomised.** `variant_roll(col, row, tileId)` is
FNV-1a — a hash, not an RNG — so a cell answers the same thing every frame and
every session, and no seed travels with the map.

**Resolution is implemented twice, and pinned.** Rust owns the model, the
validator and `resolve_tile_render`; TypeScript mirrors it in
`apps/web/src/renderer/tile-art.ts`, because it runs once per visible cell per
frame and one WASM crossing per tile is what `CLAUDE.md` forbids. This is
ADR-0011's precedent, and carries its obligation: mirrored unit tests on both
sides, plus `engine-integration.spec.ts` comparing the mirror against the real
WASM build over both projections, a range of heights and rolls, chosen cells and
a set where `bandLevels` is `2`.

`TILE_SET_SCHEMA_VERSION` is `3`; `WORLD_SCHEMA_VERSION` gained the per-cell
choice at `2`.

## Consequences

Positive:
- an artist owns every visible pixel of a raised tile, including the difference
  between its two faces;
- surfaces and faces vary independently: eight tops and three courses is
  twenty-four looks per height, from eleven images, and no image is drawn only to
  be hidden;
- relief is unbounded in height and bounded in cost, and the art a hundred-step
  cliff needs is the art a two-step cliff needs;
- relief is retuned by one number — `elevationStep` — with the art untouched;
- a top-down map is drawn from art composed for it, and an isometric one from
  art composed for it, neither being the other resampled;
- an authored map can be *composed*: this hex shows that picture, that ridge is
  cut from rock, and neither costs a palette entry or a rule;
- a map still stores a tile id, so repainting art never touches a world file;
- the preview cannot drift from the game, because it is not a second
  implementation of anything;
- the silhouette is exact by construction: the foot of a stack is the hexagon's
  outline for every height.

Negative:
- **this engine's hexagons are pointy-top**, so a raised tile exposes two faces
  rather than the three a flat-top layout would;
- **an elevation image is an awkward height and largely transparent** —
  it holds the `V` before it can hold the band, and the canvas keeps four corners
  that are always empty. It is easy to describe wrongly, which is why
  `scripts/tile-art.test.mjs` measures the shipped PNGs: prose is not the
  authority on the shape;
- **the art bill doubles for a project using both projections**, which is the
  honest cost of two views and why a tile may author only the one its maps need;
- **a cell now has state the roll cannot reproduce**: deleting a variant silently
  un-chooses every cell that named it, reported only if somebody validates;
- **a band that does not divide evenly overlaps by the remainder** — never
  gapped, but part of one may be permanently hidden under the next;
- **a level of the ladder needs `bandLevels` levels of height to appear**, so an
  author reading "level 3" on a map has to think in bands;
- **resolution exists in two languages** and must not drift, mitigated exactly as
  ADR-0011 mitigates the hex maths;
- `resolve_tile_render` takes seven arguments and the boundary method eight, with
  an `#[allow]` that says why: a wire has fields;
- the camera zooms freely, so a tile is pixel-exact only at the zoom its grid was
  drawn for — smoothing is off everywhere, so it stays hard-edged rather than
  blurred;
- autotiling, terrain transitions and animated tiles are **not** implemented.
  The shape leaves room for them and nothing here should be taken as having
  designed them.

## Rule

No part of a tile's art may be produced from another part, and no elevation image
may carry a top face or paint outside its band. Resolution chooses an image and
offsets it vertically; a rotation, a mirror, a skew or a non-integer scale of tile
art is a bug, and a face that needs to differ is a face an artist draws. A cliff
is drawn in whole bands stacked from its foot: `elevationStep` says how far one
level lifts a cell, `elevationHeight − shoulderDepth` says how thick a band is,
and nothing may conflate them. A cell chooses **which picture**, never **what a
tile is**.

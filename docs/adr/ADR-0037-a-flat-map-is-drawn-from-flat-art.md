# ADR-0037 — A Flat Map Is Drawn from Flat Art, or from Colour

## Status
Accepted. Extends `docs/adr/ADR-0035-tile-art-is-authored-and-resolved-by-level.md`,
whose surfaces and elevation ladders remain exactly what an **isometric** world
is drawn from. Nothing about the isometric path changes.

## Context

A world declares its projection (ADR-0016), and both are real: `topDown` is what
the editor opens by default and what a map with no relief wants, `isometric` is
what the shipped worlds use. ADR-0035 then gave a tile pixel art — surface
variants for the top face, a ladder for the faces a drop exposes — and the
renderer drew that art in **both** modes.

That was wrong, and it is visible. The two projections do not show the same
shape:

```text
   top-down                 isometric
   width : height           width : surfaceHeight
   64 : 74                  64 : 40
   = sqrt(3) : 2            = whatever tilt the grid declares
```

A surface image *is* the projected top face's bounding box — that is the whole
point of deriving the projection from the art (ADR-0035). Blitted into a
top-down map it covers the top 40 rows of a 74-row hexagon and leaves the rest
bare, and stretching it to fit would squash a drawing that was composed for a
different outline. Either way the map reads as broken art rather than as a
different view.

Three answers were rejected.

**Scale the surface into the flat hexagon.** One image, no new authoring — and a
non-integer vertical scale of pixel art, which is the resampling ADR-0029 and
ADR-0035 both exist to forbid. Grass drawn at 40 rows and shown at 74 is not
grass seen from above; it is grass with every row doubled somewhere.

**Draw the flat hexagon from the surface plus the elevation faces.** Composing
the two would fill the outline, and it would be a lie: the faces are lit as
vertical walls, and a map seen straight down has no walls.

**Keep one image and let the tile set declare which projection it is for.** That
makes a tile set unusable on half the maps in a project, when the thing that
actually varies is which picture to reach for.

## Decision

**A tile carries a third list: `art.flat`, the untilted hexagon.** It sits
beside `surface` and `elevation` and is authored on the same width, at
`art.flatHeight` — `width * 2 / sqrt(3)`, the hexagon's own bounding box, with
nothing tilted. `flatHeight` is a **required** field of a declared grid, for the
reason the other three are: a set that says how tall its surfaces are and stays
silent about its flat images would be guessing on the renderer's behalf.

**The projection chooses, and the two never mix.** `resolve_tile_render` takes
the world's `ProjectionMode` and answers with `flat` alone or with
`surface` + `layers` alone; `ResolvedTileRender` carries both fields and fills
exactly one. A top-down world therefore draws **no relief at all** — which is
already true of the polygon path, whose `elevationStep` is zero in that mode.

**A tile with no flat art draws its `fallbackColor` in a top-down world.**
Resolution returns nothing, and the renderer fills the hexagon exactly as it
does for a tile that authors no art whatsoever
(`docs/adr/ADR-0009-assets-tilesets.md`). This is the decision the alternative
would quietly undo: falling back to the surface image is worse than falling back
to colour, because a wrong picture reads as a bug in the art and a flat colour
reads as art that has not been drawn yet.

**One chosen variant serves both views.** ADR-0036's `art.surface` on a placed
cell is an index, and that index picks out of `flat` in a top-down world and out
of `surface` in an isometric one, wrapping when the two lists are different
lengths. A set that ships both gives them matching ids, so a cell that chose `f`
shows `f` whichever way its map is drawn; a cell whose id exists in only one
list resolves against the other rather than losing its choice.

**The tools follow the same split.** The asset editor gains a `Flat` tab, its
own guide — the untilted hexagon, from `flatHexagon()` rather than drawn by eye
— and a preview that switches to top-down while that tab is open, because
authoring a view you cannot look at is authoring blind.

**`TILE_SET_SCHEMA_VERSION` is `3`.** A version-2 file that declared an `art`
block no longer parses, which is the point: the field is required. The shipped
set says `3`, and `scripts/generate-tile-art.mjs` now draws 184 images —
eight flats and eight surfaces for each of seven terrains, plus the three
ladders.

**Resolution stays mirrored, and the mirror stays pinned.** The projection is
the resolver's third argument in both languages, `previewTileRender` grew the
matching parameter, and `engine-integration.spec.ts` compares the two
implementations over **both** modes. A mirror that agreed on only one of them
would be half a mirror (ADR-0014's obligation, ADR-0035's mirror).

## Consequences

Positive:

- a top-down map is drawn from art composed for a top-down map, and an
  isometric one from art composed for an isometric one — neither is the other
  resampled;
- the same painter draws both. `generate-tile-art.mjs` swaps the outline it
  masks to and keeps the material, the noise and everything scattered on it, so
  grass is the same grass in both views for the cost of one canvas height;
- the fallback is a decision rather than an accident: a projection a tile has no
  art for is a flat colour, which is what "not drawn yet" has always looked like
  on this map;
- a set may ship one view and not the other. A project that is only ever
  isometric never authors a flat image, and pays nothing for the field;
- the flat image is validated by the same `variant_list_issues` the other lists
  go through, and `scripts/tile-art.test.mjs` measures the shipped PNGs against
  the untilted hexagon — the shape is pinned by a test rather than by prose,
  which is the lesson ADR-0035's Status records.

Negative:

- **the art bill doubles for a project that uses both projections.** Seven
  terrains went from 56 surfaces to 56 surfaces and 56 flats. That is the honest
  cost of two views, and it is why a tile may author only the one its maps need;
- **a top-down map shows no relief.** `elevation` is still authored, still
  packed, still read by the rules — it simply has nothing to draw in this
  projection. That was already the case for the polygon path; it is now the case
  for the art too, and it is stated rather than implied;
- **`resolve_tile_render` takes seven arguments, and the boundary method eight.**
  Clippy says so, and the three boundary methods carry an `#[allow]` that says
  why: a wire has fields. A parameter object would read better in TypeScript and
  worse in `wasm_bindgen`, and the boundary is documented parameter by parameter
  in `docs/wasm-api.md`;
- **a version-2 tile set that declared a grid is broken by this change.** No
  migration is written, deliberately (`CLAUDE.md`, "Versioning"): the fix is to
  add one line, and there are no files outside this repository to fix;
- **a cell's chosen variant is one index across two lists.** Deleting a flat
  variant can therefore change which flat a cell shows without touching its
  surface. Wrapping keeps it drawing something, and matching ids keep it drawing
  the right thing, but the coupling is real and is the price of not adding a
  fourth choice to `PlacedTileArt`.

## Rule

Art authored for one projection is never drawn in the other, and never scaled,
squashed or composed to fit it. A projection a tile has no art for draws the
tile's `fallbackColor` — never a picture belonging to the other view.

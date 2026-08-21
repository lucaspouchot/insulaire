# ADR-0041 — A Cliff Is Stacked in Bands, Not in Levels

## Status
Accepted. Amends
`docs/adr/ADR-0035-tile-art-is-authored-and-resolved-by-level.md` on two points:
that an elevation image holds a band *exactly* `elevationStep` rows thick, and
that a cell of height *h* over a base *b* resolves to `h − b` layers. Everything
else that ADR decided stands — the ladder, the repeat rule, the variant roll,
the derived projection, the mirrored resolver and its Rule.

## Context

The relief was too pronounced: a mountain at elevation 4 towered over the map,
and the request was to lower it **without touching the art**.

The dial is one number in the tile set. ADR-0035 derives the projection from the
authored grid, so a cell rises `elevationStep` authored pixels per level; the
shipped set said 16, and halving it to 8 halves every cliff on every map at the
cost of one line of content. Nothing else in the pipeline has to know.

Except that 16 was doing two jobs. It was also *the thickness of the band an
artist draws*, which is what the canvas leaves under the `V` —
`elevationHeight − shoulderDepth` — and what `faceGuides()` has always marked in
the asset editor. `crates/world/src/tile_art.rs` had already written the two
apart:

> Normally the same as `face_height`, so a stack of levels meets edge to edge. A
> smaller value overlaps them on purpose.

**"Overlaps them on purpose" is not what one image per level does.** Each image
in a stack is covered by the one above it, so a layer shows only the
`elevationStep` rows the next one leaves exposed: with a step half the band, a
cliff became the same 8-pixel slice of the same picture repeated all the way
down. A cell fixes its variant once (ADR-0036) and the repeat rule reuses one
level above the last authored one, so the slices were not merely similar, they
were identical — a stripe, not a rock face. The observation that opened this was
"le motif est très répété sur de l'élévation".

The same arithmetic broke the silhouette at the other end. A stack anchored by
its top left its lowest image hanging `band − elevationStep` pixels past the
hexagon's outline — the overhang that ADR-0035's own correction had just removed
from the shipped art. Anchoring the stack at its foot fixed the outline and left
the stripes untouched, which is what said the stack was cut wrong, not placed
wrong.

## Decision

**A layer is a band of faces, not a level of elevation.**

```text
  bandLevels = max(1, floor(faceHeight / elevationStep))
  layers     = ceil((h − b) / bandLevels)          capped at MAX_STACKED_LEVELS
  level(n)   = max(1, floor(b / bandLevels) + n)   n from the foot, 1-based
  drop(n)    = (h − b) − n × bandLevels            in steps, signed
```

**A band spans several levels when a step is shorter than it.** One image is
drawn per band, so the art is shown as it was drawn — whole — and the cliff is
still exactly `(h − b) × elevationStep` pixels tall. Three levels of the shipped
set are one whole 16-pixel image and half of the next, not three slices of one.

**Bands are stacked from the foot up.** The lowest band's own lower edge is the
cell's silhouette, whatever the cell's height, so a cliff ends on the hexagon's
outline rather than past it or short of it. The topmost band may then start
*above* the top face, which is drawn last and covers it: `drop` is therefore
**signed**, and a composed picture carries the rows above the surface it needs
(`pictureTop`, ADR-0038).

**Which ladder level a band draws is its index from the ground**, not its
height: `floor(b / bandLevels) + n`. A cliff on higher ground shows the stratum
its taller neighbour shows at that height, so strata line up across a map, and
the ladder is walked one level per band — level 1, then level 2 — rather than
skipping the levels a taller band steps over.

**`bandLevels = 1` is ADR-0035 exactly.** A set whose step *is* its band
resolves to one image per level at drops `h − b − 1 … 0`, layer for layer, as
every set said before the two numbers were told apart. The span is computed from
the geometry in one place on each side — `TileArtGeometry::band_levels` and
`bandLevels()` in `apps/web/src/content/content-types.ts` — and passed into the
resolver, which stays the geometry-free, mirrored function ADR-0035's Rule
describes.

The shipped set is a 16-pixel band lifted 8 pixels a level: `bandLevels` is `2`,
and every map drawn from it has half the relief it had, from the same PNGs.

## Consequences

### What this buys

- **Relief is retuned by one number.** `elevationStep` is the only thing an
  author changes to make a world flatter or taller; the art is untouched and the
  number of drawn images follows.
- **The art is drawn whole.** A band is shown as an artist drew it, so a cliff
  reads as strata rather than as a repeating strip, and a tall one repeats at
  the band's scale — which is the scale the repeat rule was written for.
- **The silhouette is exact by construction.** The foot of a stack is the
  hexagon's outline for every height, so neither the overhang nor the sawn-off
  foot can come back through a geometry change.
- **Fewer blits per cliff.** Half as many layers per cell at `bandLevels = 2`,
  and the cap now bounds bands rather than steps, so a deep drop costs less.

### What it costs

- **`drop` is signed** in `ResolvedTileLayer`, on both sides of the boundary and
  in `docs/wasm-api.md`. A host that read it as unsigned reads it wrong.
- **A level of the ladder needs `bandLevels` levels of height to appear.** The
  asset editor raises its preview to `level × bandLevels` when a level is
  opened, and an author reading "level 3" on a map has to think in bands.
- **A band that does not divide evenly overlaps by the remainder.** `bandLevels`
  rounds down, so bands are never gapped — the colour wall never shows through —
  but part of one may be permanently hidden under the next.
- **One more parameter on the resolver**, which is the mirrored function this
  project pins twice. The span is a set-wide integer, so it is passed, not
  derived, and the mirror tests cover a set where it is `2` as well as `1`.

## Alternatives rejected

**Redraw the art at 8 pixels a band.** The request was explicitly not to touch
the assets, and it would have halved the detail an artist can put in a stratum
rather than the height of a cliff.

**Halve the authored elevations instead** — keep a 16-pixel step and edit every
map so a mountain is 2 rather than 4. It rewrites authored content to change a
presentation constant, throws away the odd heights, and leaves a click on
*Raise* worth a whole band.

**Crop the image to the step when blitting.** A band's lower edge is the `V` of
the hexagon's two lower edges, drawn in its own pixels; cutting rows off the
bottom cuts that `V` off and ends the cliff on a flat line. Nothing in this
engine transforms tile art to make other tile art (ADR-0035), and this is that
rule wearing a different hat.

**A separate `elevationLift` field** beside `elevationStep`, so the step keeps
meaning "the band". It is the same decision with a schema change and a second
number to keep consistent; the band's thickness is already implied by the canvas
(`elevationHeight − shoulderDepth`), so there was nothing to add.

## Rule

A cliff is drawn in **whole bands, stacked from its foot**. How many images it
takes is what the art's band height dictates, never what the elevation count
dictates. `elevationStep` says how far one level lifts a cell;
`elevationHeight − shoulderDepth` says how thick a band is. The two are not the
same question, and nothing may conflate them again.

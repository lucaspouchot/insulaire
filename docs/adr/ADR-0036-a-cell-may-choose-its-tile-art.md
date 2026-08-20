# ADR-0036 — A Cell May Choose Its Tile Art, and a Cliff May Be Borrowed

## Status
Accepted

## Context

ADR-0035 made a tile's picture authored: surface variants for the top face, a
ladder of elevation levels for the faces a drop exposes. Which variant a given
cell draws is decided by `variant_roll(col, row, tileId)` — a hash, not an RNG —
so a field of grass is not the same forty pixels forty times and no seed has to
travel with the map.

That is the right default and the wrong absolute. Three things it cannot say:

**"Not that one, this one."** A map is authored (ADR-0003). An author who wants
the flowered grass at the mouth of a valley and the scuffed grass on the path
has no way to say so, and the only workaround — a second `grass_path` tile —
buys a palette entry, a movement cost and a terrain family to express a choice
of picture.

**"Grass on top, rock underneath."** The shipped set draws seven terrains and
three cliffs: earth, stone and mountain. A grass mesa standing on a rock cliff
is an obvious thing to want and, under ADR-0035, an impossible one — a tile's
faces come from that tile's ladder or from nothing. Authoring a `grass` ladder
that is a copy of `rock`'s would be twenty-four images drawn to say "the same".

**"The cut should match the ground."** Resolution rolled each layer with
`roll + level`, so the faces under one cell alternated between variants down the
column. That reads as courses of masonry rather than as one cut through one
hillside, and it means the cliff under `grass_f` has nothing to do with
`grass_f`.

A per-cell **layer index** was rejected: it would put the renderer's data model
in the map file, and inserting a variant into a tile set would silently repaint
every cell that named an index below it. Three dense per-cell buffers — one for
the surface, one for the ladder, one for the variant — were rejected too: a
choice is an exception, and three megabytes of zeroes per million cells is the
cost of a feature almost no cell uses.

## Decision

**A placed cell may carry `art`: `{ surface?, elevationTile?, elevation? }`, all
by id, all optional.** Absent — which is what nearly every cell of nearly every
map says — the roll decides, exactly as before. The block is presentation, like
`elevation` beside it: no rule reads it, and no rule may.

**`elevationTile` names the tile whose ladder cuts the faces, and nothing else.**
The top face always comes from the cell's own tile, at every height, which is
ADR-0035's rule and is what makes the borrow worth having: grass on top, rock
underneath, from art that already exists. A cell may borrow a ladder its own
tile does not have, and may borrow one that is empty, which draws no faces.

**Ids, not indices.** An author reads `f` in the tile set, and `f` survives a
variant being inserted above it. The renderer wants an index, so the search
happens **once**, when `WorldGrid` flattens the map — `resolve_cell_art` — and
never in a draw call. The engine hands the result to the renderer as
`WorldView.artChoices`: a sorted, sparse list of resolved indices, not a buffer.

**The cut follows the ground.** `elevation` absent means "the variant the
surface took", so a cell showing `grass_f` is undercut by `dirt_f` at every
level of its drop and a cliff reads as one cut through one hillside. This
replaces ADR-0035's `roll + level`; the variety that rule was reaching for comes
from the levels themselves and from neighbouring cells, which is where a cliff
actually varies. A ladder whose level has fewer variants wraps rather than
losing the layer.

**A dangling reference costs a cell its choice, not its picture.** An id nobody
defines resolves to nothing and the cell rolls that field as it always did.
Validation reports it — `tile.unknownSurfaceVariant`, `tile.unknownElevationTile`,
`tile.unknownElevationVariant`, `tile.elevationTileWithoutLadder` — as
**warnings**, so a map that lost a variant to a repainted tile set still loads
and still plays while the author is told what stopped meaning something.

**Painting a cell drops its choice.** `grass_f` means nothing on sand, so the
map editor clears the whole block when the terrain under it changes. The editor
offers the three pickers under the paint tool, each defaulting to "automatic".

**Resolution stays mirrored, and the mirror stays pinned.** `CellArt` is the
resolved choice in both languages, `resolve_tile_render` takes it as its last
argument, and `previewTileRender` grew a `choiceJson` parameter so
`engine-integration.spec.ts` compares the two implementations over chosen cells
as well as rolled ones — ADR-0014's obligation, applied to ADR-0035's mirror.

`WORLD_SCHEMA_VERSION` is **2**. Every field is defaulted, so a version 1 file
parses and rolls its art as it always did; the shipped files say `2`.

## Consequences

Positive:

- an authored map can be *composed*: this hex shows that picture, that ridge is
  cut from rock, and neither costs a palette entry or a rule;
- three ladders serve seven terrains, and the fourth kind of cliff somebody
  wants is a choice in a map rather than twenty-four new images;
- a cliff reads as one cut: its faces agree with each other and with the ground
  standing on them;
- the cost is proportional to the exceptions. A map where nobody chose carries
  no `art` keys, builds no choice list, and does one `Map.size` check per frame;
- ids keep the file legible and reorder-proof, and the index the renderer wants
  is derived where every other id is: in Rust, once, at load.

Negative:

- **a cell now has state the roll cannot reproduce.** Deleting a variant from a
  tile set silently un-chooses every cell that named it — reported, but only if
  somebody validates;
- **three references per cell is three more things to keep straight.** The
  variant id is looked up in whichever ladder ends up drawing, which means
  changing `elevationTile` can invalidate `elevation` without touching it;
- **ADR-0035's per-level roll is gone.** A tall cliff of a repeated level now
  shows one face all the way down instead of alternating. That is the intent —
  alternating read as brickwork — but it is a visible change to existing maps;
- **the editor's panel edits the selected cell, not the brush.** Painting a
  stroke cannot carry a choice with it; each hex is chosen after the fact. A
  brush-level choice is a reasonable later feature and is deliberately not this
  one;
- autotiling and terrain transitions are still **not** implemented, and nothing
  here should be taken as having designed them — though a per-cell choice is
  the seam one would attach to.

## Rule

A cell chooses **which picture**, never **what a tile is**. `art` on a placed
tile may not change its terrain, its cost, its tags or its passability, and no
rule may read it. A choice that no longer resolves falls back to the roll; it
never draws a hole and never fails a load.

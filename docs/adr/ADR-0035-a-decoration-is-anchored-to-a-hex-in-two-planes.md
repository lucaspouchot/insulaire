# ADR-0035 — A Decoration Is Anchored to a Hex, in Two Planes, and Placed on a Map

## Status
Accepted

## Context

**A tile says what the ground *is*. Nothing said what is *on* it.** The format
has hexagons, characters standing on them and doors between maps, and no way to
author a tree. A world that needs one has to paint it into the terrain, which
makes it part of the ground: it cannot be interacted with, it cannot animate, it
cannot move a pixel, and two of them cannot share a cell.

Four things have to be true of a thing standing on a hex, and none is true of a
tile.

**It is placed at a pixel, not at a cell.** A tree is not centred on its hex —
its *trunk* is. A hanging lantern is not centred either. Centring the image and
nudging it back per placement, *as a replacement for an anchor*, makes the nudge
a property of the drawing rather than of the placement, so every author who
placed the same tree would rediscover the same two numbers.

**Depth on one cell is not a single number.** A character is *in front of* the
grass under their feet and *behind* the canopy they are under. One z-index can
only say that if the renderer knows which values mean "past the characters" — a
magic threshold, and exactly the scenario-shaped knowledge `CLAUDE.md` forbids
the engine to carry.

**It animates, but not the way a character does.** A character is a tree of
layers moved by per-node offsets with poses and mirrors (ADR-0025). A torch is
four drawings. Reusing `CharacterDefinition` would mean a skeleton, an anchor
list, a variant list and a track list to say "play these four PNGs", every one of
them empty in every decoration file.

**A placed one has to be nameable, and it is the placement that is named.** The
player opens *this* chest and searches *that* bush. A map holds a dozen chests
from one definition, and the scenario opens the one with the letter in it — so an
author who wanted nine scenery chests and one that opens would otherwise have to
author two definitions drawing the same picture.

Several shapes were rejected. **A decoration as a tile flag**: a tile is a
palette entry shared by hundreds of cells, so a chest that opens would open
everywhere. **A decoration as an entity**: an entity is *simulated* — it has a
template, a behaviour and it blocks movement — and making every bush one puts
every bush in the simulation's loop. **A decoration as a character with no
animation**: both are "a picture placed somewhere", and stopping there is how a
format grows a field that means one thing for one caller and nothing for the
other. **The placement as a `LocationDefinition` with a picture**: a point of
interest is one per cell and names a place; a decoration is many per cell and
names a thing.

## Decision

**A `DecorationDefinition` is its own content file, and it carries three numbers
a tile and a character do not.**

```json
{
  "id": "torch", "schemaVersion": 2,
  "resolution": { "width": 16, "height": 32 },
  "anchor": [8, 31],
  "plane": "front",
  "order": 2,
  "animations": [
    { "id": "burning", "frameDurationMs": 100, "looping": true,
      "frames": ["assets/decorations/torch_0.png", "assets/decorations/torch_1.png"] }
  ]
}
```

**Anchored, not centred.** `anchor` is the pixel of the decoration's own canvas
that lands on the cell's ground point. The resolver returns `placement` — the box
relative to that ground point, anchor already subtracted — so the editor's preview
and the map renderer cannot disagree about where a trunk is. An anchor outside the
decoration's own canvas is ordinary: it is a small prop dropped away from the
middle of its hex. What is worth reporting is the **drawing leaving the hexagon**,
`decoration.overflowsCell`, and that stays a warning in both directions — a big
tree is *supposed* to overhang. Measuring it needs the cell's pixel grid, so
`validate_decoration` takes an optional `TileArtGeometry` and skips the check
without one.

**Two planes, then an order.** `plane` is `behind` or `front`; `order` sorts
within it. The draw order on one cell is: everything `behind`, then the
characters, then everything `front`. Two fields rather than one, because "a
character passes between these two decorations" is not expressible as a single
number without the renderer learning a threshold.

**An appearance is a flipbook, and a state is an appearance.** A named ordered
list of image paths plus a frame duration and a loop flag. A chest declares
`closed` and `open`, each one frame long, and the scenario asks for one by id —
so *states* cost no new concept. A looping appearance wraps; one that does not
holds its last frame.

**A map carries `decorations`, a flat list of placements.**

```json
{ "id": "oak_0", "decoration": "oak", "at": [4, 7], "offset": [-6, 2], "interactive": true }
```

**The definition says what; the placement says which, where and whether.** What
is drawn is resolved once per *definition*, so a forest of two hundred oaks costs
one resolve. `id` is unique within the map — not across the project, because a
scenario names a map before it names what is on it — and it is what the scenario
addresses.

**`interactive` belongs to the placement.** A decoration may be interacted with;
it never says *what* happens, because opening a chest is scenario content and an
`if this is a chest` in the engine is what `CLAUDE.md` exists to prevent. A
definition-level default the placement overrides was rejected: three states to
express one bit, and the default is worth nothing when the answer is `false` for
nearly every placement.

**The anchor says where it belongs; the placement may nudge it.** `offset` is a
whole-pixel move from the anchored point, bounded to ±256px. The anchor carries
the tree's own arithmetic and the nudge is the variety on top, which is the only
reason two placements of one definition ever differ — a row of the same fence post
at exactly the same pixel reads as a stamp.

**Several may share a cell, and author order settles them.** The draw order is
`plane`, then `order`, then the order the author placed them. Sorting happens once
per model, in `renderDecorations`, and both hosts use it — a renderer that sorted
its own way would be a second opinion about content.

**A reference is resolved next to the project, not inside the world.**
`validate_world` checks the shape — unique id, a hex under it, a definition named
— and `validate_placed_decorations` resolves the id when the project loads,
exactly as a door's `targetWorld` is (ADR-0014).

**The engine resolves it, as it resolves a character.** `resolveDecoration` and
`previewDecoration` cross the boundary beside `resolveCharacter`, so the editor's
preview and the runtime draw what the same Rust code produced.

**The editor sets the anchor by dragging and plants by clicking.**
`/editor/asset/decorations` draws the decoration on a hexagon at the project's own
tile geometry, with a real resolved character standing on the same ground point —
because the question the plane answers is "does a character pass in front of
this", and a rat and a dragon disagree about whether a fence hides them. The zoom
holds the hexagon and the decoration's box and deliberately not the figure: a
guide may be clipped, the cell may not. `/editor/map` gains a decoration tool, and
the placement is selected the moment it lands, because the second question an
author has about a tree they just planted is whether it can be searched. The
eraser removes the one drawn last, then falls through to the entity, the door and
the location.

`WORLD_SCHEMA_VERSION` is `6` and `DECORATION_SCHEMA_VERSION` is `2`.

## Consequences

Positive:
- a tree, a house and a chest are authorable content, several share a cell, and a
  map can be dressed;
- an author *sees* the plane decision instead of reasoning about it, and places
  the anchor by dragging rather than by arithmetic;
- animation costs one list of paths, so a torch is a file a person can read;
- a state and an appearance are one concept, so the scenario has somewhere to
  point before the scenario runtime exists;
- the interaction bit is where the scenario will look for it — on the thing that
  has an id — so nine scenery chests and one that opens are one definition;
- the engine still contains no interaction rule.

Negative:
- **a fourth content kind to keep in step** across Rust type, TypeScript mirror,
  serialiser, validator, boundary method, library service and editor;
- **two ways to animate**: a character by skeleton, a decoration by flipbook, and
  an author has to know which they are editing. The alternative was one format
  mostly empty in both;
- **nothing consumes `interactive`** — there is no scenario runtime, so the bit is
  authored, stored and read by nobody;
- **a placement cannot override plane or order**, so two oaks on one hex sort by
  author order and nothing else;
- **the nudge is typed, not dragged**: hit-testing decorations on the map canvas
  is not in this decision;
- **the figure can be clipped** in the editor, which is the price of keeping the
  hexagon whole;
- the overflow warning needs a cell, so it is silent exactly where a definition is
  loaded rather than authored;
- **no decoration ships in `content/`**, so the map editor's brush is empty in
  this project until art is drawn.

## Rule

A decoration is anchored at a pixel and sorted in one of two planes, never one
combined z-index. Whether it can be interacted with is decided where it is
placed, never where it is drawn; a placement's id — unique within its map — is
what the scenario addresses; and what happens is the scenario's, with no rule
about a decoration living in the engine.

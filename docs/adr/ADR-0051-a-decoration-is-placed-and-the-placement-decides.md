# ADR-0051 — A Decoration Is Placed, and the Placement Decides

## Status
Accepted. Completes
`docs/adr/ADR-0048-a-decoration-is-anchored-to-a-hex-in-two-planes.md`, which
defined the kind and left the instance for later, and **amends** it: `interactive`
moves off the definition. `WORLD_SCHEMA_VERSION` goes to `6` and
`DECORATION_SCHEMA_VERSION` to `2`.

## Context

**ADR-0048 shipped a decoration nothing could put on a map.** Its own
consequences said so: "no map can place a decoration yet, and nothing draws one
outside the editor". An author could draw a tree and never plant it.

Placing it raises the question ADR-0048 answered in the wrong place.

**`interactive` was a property of the wrong thing.** ADR-0048 put it on the
*definition*: this kind of chest can be opened. But a map holds a dozen chests
from one definition, and the scenario opens *one* of them — the one with the
letter. Under a definition-level flag, an author who wants nine scenery chests
and one that opens has to author two definitions that draw the same picture,
and the scenario then addresses the placement anyway. The bit belongs where the
id it travels with belongs: on the instance.

That reading was already latent in ADR-0048, which said "a placed decoration
carries its own id … because one definition is placed many times, and only the
placement is a thing a player can open". It then put the *can* on the kind.

Two shapes were rejected.

**Keep the definition flag as a default the placement overrides.** Three states
(`inherit`, `yes`, `no`) to express one bit, and a validator that has to explain
which won. The default is worth nothing: the answer is `false` for nearly every
placement, and `false` is what a new placement already is.

**Make the placement a `LocationDefinition` with a picture.** A point of
interest is one per cell and names a place; a decoration is many per cell and
names a thing. Merging them would put `plane` and `order` on locations and a
name on every bush.

## Decision

**A map carries `decorations`, a flat list of placements.**

```json
{ "id": "oak_0", "decoration": "oak", "at": [4, 7], "offset": [-6, 2], "interactive": true }
```

**The definition says what, the placement says which, where and whether.** A
`DecorationDefinition` keeps the anchor, the plane, the order and the
appearances; `interactive` is gone from it. What is drawn is resolved once per
*definition* — `resolveDecoration` — and the placement is the cheap part, which
is what lets a forest of two hundred oaks cost one resolve.

**The anchor says where it belongs; the placement may nudge it.** `offset` is a
whole-pixel move from the point the definition's anchor puts it on, bounded to
`±256px`. ADR-0048 rejected a per-placement offset, and was right about what it
rejected: an offset *instead of* an anchor makes every author rediscover the
same two numbers for the same tree. This is the other thing — the anchor still
carries the tree's own arithmetic, and the nudge is the variety on top, which
is the only reason two placements of one definition ever differ. A row of the
same fence post at exactly the same pixel reads as a stamp, and that is a
problem no definition can fix, because it is not about the post.

**`id` is unique within the map, and it is what a scenario addresses.** Not
unique across the project: two maps may each have an `oak_0`, and a scenario
names a map before it names what is on it.

**Several may share a cell, and author order settles them.** The draw order is
`plane`, then the definition's `order`, then the order the author placed them —
which is the tie-break ADR-0048 left open. Sorting happens once per model, in
`renderDecorations`, and both hosts use it: the map editor over the document,
Play over the world view. A renderer that sorted its own way would be a second
opinion about content.

**A reference is resolved next to the project, not inside the world.** A world
file cannot know which decorations exist, so `validate_world` checks the shape —
unique id, a hex under it, a definition named — and `validate_placed_decorations`
resolves the id when the project loads, exactly as `targetWorld` is resolved
(`docs/adr/ADR-0017-map-links.md`).

**The editor plants and then asks.** `/editor/map` gains a decoration tool: pick
one from the project's decorations, click hexes to plant them. The placement is
selected the moment it lands, and the panel under the brush is where its
`interactive` box lives — because the second question an author has about a tree
they just planted is whether it can be searched.

**The eraser takes one.** A cell may hold three decorations, so the eraser
removes the one drawn last, then falls through to the entity, the door and the
location as before. Carving a hex out from under a decoration is refused like
every other authored record (`docs/adr/ADR-0046-a-map-is-a-set-of-hexes.md`).

## Consequences

Positive:

- a map can be dressed: trees, houses and chests, several to a hex, drawn in
  Play and in the editor by the same code;
- the interaction bit is where the scenario will look for it, on the thing that
  has an id, so nine scenery chests and one that opens are one definition;
- the tie ADR-0048 left undecided is decided, and decided as content: author
  order, not a renderer's iteration order;
- the placement is small — four fields — so a map file with two hundred trees is
  two hundred readable lines.

Negative:

- **two schema versions in one change**, and no reader for either old field. A
  world at `5` loads with no decorations, which is what it meant; a decoration
  at `1` loses its `interactive`, which nothing had placed yet;
- **nothing consumes `interactive`.** There is no scenario runtime, so the bit
  is authored and stored and read by nobody. It is a bet that the scenario will
  address a placement by id — which is the shape ADR-0005 already implies;
- **a placement cannot override plane or order.** Two oaks on one hex sort by
  author order and nothing else; an author who wants one deliberately behind the
  other must reorder or use a second definition. Adding an override later is a
  field, not a redesign;
- **the nudge is typed, not dragged.** The inspector offers two numbers, four
  one-pixel buttons and a reset; dragging a placed decoration on the map canvas
  would need the pointer pipeline to hit-test decorations, which this change
  does not add. The decoration editor drags because it has one thing on screen;
- **no decoration ships in `content/`**, so the map editor's brush is empty in
  this project until art is drawn. The tool says so rather than pretending;
- the eraser's "one at a time" is a choice an author has to learn: clicking a
  crowded hex three times empties it.

## Rule

Whether a decoration can be interacted with is decided where it is placed, never
where it is drawn; and a placement's id — unique within its map — is what the
scenario addresses.

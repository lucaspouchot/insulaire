# ADR-0033 — A Map Is a Set of Hexes, Not a Rectangle

## Status
Accepted

## Context

A map used to be a `width x height` block of offset coordinates anchored at
`[0, 0]`. That earned its keep — the packed buffer, the file coordinate and the
screen position all agree, and `[col, row]` is what an author reads — but it made
the rectangle the *shape of the world* rather than the shape of the storage.
Every cell inside the box existed; nothing outside it did.

An authored world is an archipelago before it is a grid. The requirement is a
coastline: hexes removed where the sea is, kept where the land is, and nothing
forcing the land to be one connected blob.

**A `void` tile in the palette** was rejected. It is the cheapest change and it
answers the wrong question: a tile says what a hex is *made of*, absence says the
hex is not there. Conflating them makes every tile set ship a void, makes an
impassable tile indistinguishable from a hole for the renderer, the grid, the
camera and hit-testing, and costs a cell its paint the moment it is carved out
and put back.

**Storing cells sparsely** was rejected against `CLAUDE.md`, "Performance": the
dense row-major buffers are what let a 2048x2048 map cross the boundary in three
calls instead of eight million.

Extending a map is the half with a trap in it. Growing east or south is free.
Growing north or west with the origin pinned at `[0, 0]` means renumbering every
authored cell — and odd-r is not translation-invariant, so a shape translated by
an odd number of rows is a *different shape*. It would also silently move the
`targetAt` of every door in every other map pointing into this one, which is a
cross-file reference no single-world edit may touch (ADR-0014).

## Decision

**A map is a set of hexes.** `WorldGrid::contains` means "the map has this hex",
not "this coordinate is inside the bounding box". Everything follows from that
one sentence: `tile_at` answers `None` on an absent cell, so `is_passable` is
false and `movement_cost` is `None`, so `validate_move` rejects a step into a
hole with the `OutOfBounds` it already had. A hole *is* outside the map, and no
simulation rule learned anything new.

**The extent is a `MapBounds`, and it has an origin.**
`MapBounds { origin, width, height }` is the rectangle the dense buffers are
indexed against, and bounds questions belong to it. The world file carries
`origin` beside `width` and `height`:

```json
{ "origin": [-4, -6], "width": 28, "height": 32, … }
```

An authored coordinate therefore means the same hex forever: extending a map
northwards moves the origin, not the cells.

**The shape is authored the way tiles are — a default plus exceptions.**

```json
"shape": { "default": "present", "exceptions": [[3, 0], [4, 0]] }
```

`present` with a list of holes is what carving a coastline out of a full canvas
produces; `absent` with a list of hexes is what drawing an archipelago on an
empty one produces. An author does whichever is smaller, and so does the editor.
Omitted means a full rectangle, which is what every map authored before this
said.

**Presence crosses the boundary as a third dense buffer**, one byte per cell in
the same row-major layout as terrain and elevation. A bit per cell would be eight
times smaller and was rejected for now: a byte is one array read in the render
loop rather than a shift and a mask, and packing it later is a change behind
`WorldGrid` rather than to this decision.

**Paint survives under a hole.** Carving a hex does not clear its tile, elevation
or art choice, so trimming a coastline and changing your mind loses nothing.
Validation reports a painted absent cell as a warning, never an error.

**Nothing that stands on a hex may stand on a hole.** An entity, a location, a
door or a decoration on an absent cell is an error, and the editor refuses to
carve a cell carrying any of them and says which.

**Connectivity is never checked.** Three rocks off the western shore are a
legitimate map.

`WORLD_SCHEMA_VERSION` becomes 4.

## Consequences

Positive:
- the world's shape is authored content, like everything else about it, instead
  of an accident of the storage layout;
- the dense buffers, the culling and the boundary crossings are untouched — the
  renderer skips a cell instead of drawing it, for one array read;
- the simulation gained the shape for free, because "outside the map" already had
  exactly one meaning and one caller;
- extending a map is expressible at all, and expressible without renumbering
  anything or breaking a door in a file nobody opened.

Negative:
- the bounding box no longer bounds anything an author cares about, so `width x
  height` in the editor is a canvas size and the present-cell count is what an
  author should read;
- a mostly-empty map still costs a full rectangle of buffers, and trimming the
  extent is the author's job;
- negative coordinates are now ordinary, and `[-3, -7]` is harder to locate by
  eye than `[3, 7]`;
- three dense buffers instead of two.

## Rule

Ask the map whether it has a hex; never infer it from the bounding box.
`MapBounds::contains` answers where a *buffer index* lives, `WorldGrid::contains`
answers whether the *world* has that hex, and only the second one is a rule.

# ADR-0046 — A Map Is a Set of Hexes, Not a Rectangle

## Status
Accepted

## Context

Since ADR-0014, a map has been a `width x height` block of offset coordinates
anchored at `[0, 0]`. That choice earned its keep — the packed terrain buffer,
the file coordinate and the screen position all agree, and `[col, row]` is what
an author reads — but it also made the rectangle the *shape of the world*, not
merely the shape of the storage. Every cell inside the box exists; nothing
outside it does.

An authored world is an archipelago before it is a grid. The requirement is a
coastline: hexes removed where the sea is, hexes kept where the land is, and
nothing forcing the land to be one connected blob — a map should be able to hold
a main island and three rocks off its western shore.

Three ways to say "there is no hex here" were considered.

**A `void` tile in the palette** was rejected. It is the cheapest change — the
terrain buffer already carries a palette index per cell — but it answers the
wrong question. A tile says what a hex is *made of*; absence says the hex is not
there. Conflating them makes every tile set responsible for shipping a void, an
impassable tile indistinguishable from a hole for the renderer, the grid, the
camera and hit-testing, and it costs the map its paint the moment a hex is
carved out and put back.

**Storing cells sparsely** — a map from `Hex` to cell — was rejected against
`CLAUDE.md`, "Performance": the dense row-major buffers are what let a 2048x2048
map cross the WASM boundary in three calls instead of eight million, and the
renderer indexes them per cell per frame.

**A presence mask over a bounding box** is what this ADR adopts: the rectangle
survives as the *extent the buffers cover*, and stops being the world's shape.

Extending a map is the second half of the problem, and the half with a trap in
it. Growing eastwards or southwards is free. Growing northwards or westwards, if
the origin stays pinned at `[0, 0]`, means renumbering every authored cell — and
odd-r is not translation-invariant: shifting every row by one flips which rows
are the shifted ones, so a shape translated by an odd number of rows is a
*different shape*. Renumbering would also silently move the `targetAt` of every
door in every *other* map pointing into this one, which is a cross-file
reference no single-world edit may touch (ADR-0017).

## Decision

**A map is a set of hexes.** `WorldGrid::contains` now means "the map has this
hex", not "this coordinate is inside the bounding box". Everything downstream
follows from that one sentence: `tile_at` answers `None` on an absent cell, so
`is_passable` is false and `movement_cost` is `None`, so `validate_move` rejects
a step into a hole with the `OutOfBounds` it already had — a hole *is* outside
the map. No simulation rule learned anything new.

**The extent is a `MapBounds`, and it has an origin.** `MapBounds { origin,
width, height }` is the rectangle the dense buffers are indexed against.
`OffsetCoord::is_within` / `index_in` / `from_index` are gone; bounds questions
belong to the bounds. The world file carries `origin` alongside `width` and
`height`, defaulting to `[0, 0]`:

```json
{ "origin": [-4, -6], "width": 28, "height": 32, … }
```

An authored coordinate therefore means the same hex forever. Extending a map
northwards moves the origin, not the cells — the shape keeps its parity, and
another map's door keeps pointing where its author put it.

**The shape is authored the way tiles are: a default plus exceptions.**

```json
"shape": { "default": "present", "exceptions": [[3, 0], [4, 0]] }
```

`default: "present"` with a list of holes is what carving a coastline out of a
full canvas produces; `default: "absent"` with a list of hexes is what drawing
an archipelago on an empty one produces. An author does whichever is smaller,
and the editor writes whichever is smaller. Omitted entirely — the value every
map authored before this ADR has — means a full rectangle, unchanged.

**Presence crosses the boundary as a third dense buffer**, `presenceBuffer`, one
byte per cell in the same row-major layout as `terrainBuffer` and
`elevationBuffer`. A bit per cell would be eight times smaller and was rejected
for now: a byte is what the two buffers beside it already spend, it is one array
read in the render loop rather than a shift and a mask, and 4 MB on the largest
legal map sits next to 8 MB already spent. If that bites, packing it is a
change behind `WorldGrid`, not a change to this decision.

**Paint survives under a hole.** Carving a hex does not clear its tile,
elevation or art choice. Restoring it restores what was there, and an author who
trims a coastline and changes their mind loses nothing. Validation reports a
painted absent cell as a *warning* (`tile.absentCell`), never an error.

**Nothing that stands on a hex may stand on a hole.** An entity, a location or a
door on an absent cell is an error — `entity.absentCell`, `location.absentCell`,
`link.absentCell`, and `link.absentTargetCell` for a door arriving on one. The
editor refuses to carve a cell that carries any of them and says which, rather
than destroying authored content or leaving it dangling in the void.

**Connectivity is never checked.** Three rocks off the western shore are a
legitimate map. No rule, no validator and no export asks whether the present
cells form one component.

`WORLD_SCHEMA_VERSION` becomes 4.

## Consequences

Positive:
- the world's shape is authored content, like everything else about it
  (ADR-0003), instead of an accident of the storage layout;
- the dense buffers, the culling and the boundary crossings are untouched — the
  renderer skips a cell instead of drawing it, and pays one array read for the
  privilege;
- the simulation gained the shape for free, because "outside the map" already
  had exactly one meaning and one caller;
- extending a map is now expressible at all, and expressible without renumbering
  anything or breaking a door in a file nobody opened.

Negative:
- the bounding box no longer bounds anything an author cares about, so two
  numbers that used to describe the map now describe its storage. `width x
  height` shown in the editor's map panel is a canvas size, not a world size,
  and the present-cell count is what an author should read;
- a map can now be mostly empty, and a mostly-empty map still costs a full
  rectangle of buffers. Trimming the extent is the author's job and the editor
  offers it, but nothing forces it;
- negative coordinates are now ordinary in authored files, and `[-3, -7]` is
  harder to locate by eye than `[3, 7]`;
- three dense buffers instead of two.

## Rule

Ask the map whether it has a hex; never infer it from the bounding box.
`MapBounds::contains` answers where a *buffer index* lives, `WorldGrid::contains`
answers whether the *world* has that hex, and only the second one is a rule.

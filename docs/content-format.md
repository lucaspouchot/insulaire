# Content Format v1

Authored content is JSON on disk. Every file carries an `id` and a
`schemaVersion` (ADR-0006), references other content by stable id (ADR-0009),
and is validated by the engine before it can be loaded (ADR-0015).

Two file kinds exist in the MVP:

```text
content/
├── tilesets/mvp_terrain.json     TileSetDefinition — the palette worlds paint with
└── worlds/demo_world.json        WorldDefinition   — an authored map
```

Canonical implementations:

| Concern | Rust | TypeScript |
|---|---|---|
| Types | `crates/world/src/definition.rs`, `tileset.rs`, `decoration.rs`, `object.rs` | `apps/web/src/content/content-types.ts` |
| Validation | `crates/world/src/validation.rs` | *(none — see ADR-0015)* |
| Writing | `serde_json` | `apps/web/src/content/world-serializer.ts`, `decoration-serializer.ts`, `object-serializer.ts` |

---

## Coordinates

Positions are **odd-r offset** pairs written as a two-element array:

```json
"at": [4, 10]
```

meaning column 4, row 10. Rows run horizontally, `row` increases downwards, and
odd rows are shifted half a hex to the right. Full rationale in ADR-0014.

A world's **extent** is the rectangle its dense buffers cover: `width` columns
and `height` rows, anchored at `origin` (default `[0, 0]`). It addresses `col`
in `origin.col .. origin.col + width` and `row` in `origin.row .. origin.row +
height`; anything outside is a validation error. Coordinates may be negative,
which is what a map extended northwards or westwards produces.

The extent is **storage, not shape**. Which of its cells the map actually has is
authored in `shape`, and a map is a *set of hexes*: it may be carved into any
outline, and its islands need not touch
(`docs/adr/ADR-0046-a-map-is-a-set-of-hexes.md`). Extending a map moves the
origin rather than renumbering its cells, so an authored coordinate names the
same hex forever — which matters because odd-r is not translation-invariant, and
because a door in another map names a coordinate in this one.

---

## TileSetDefinition

The palette a world may paint with.

```json
{
  "id": "mvp_terrain",
  "schemaVersion": 2,
  "name": "MVP Terrain",
  "art": { "width": 64, "surfaceHeight": 40, "elevationHeight": 26, "elevationStep": 8 },
  "tiles": [
    {
      "id": "grass",
      "name": "Grass",
      "terrain": "grass",
      "movementCost": 1,
      "tags": ["open"],
      "visual": { "visualId": "terrain.grass", "fallbackColor": "#4a7c3f" }
    }
  ]
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Stable id; worlds reference it through `tileSetId`. |
| `schemaVersion` | integer | yes | `3`. Higher versions are rejected. |
| `name` | string | no | Shown in the editor. |
| `art` | TileArtGeometry | no | The pixel grid every image in the set is drawn on. Defaults below. |
| `tiles` | TileDefinition[] | yes | At least one, at most 256. |

**Version 2** added `art`, on the set and on each tile
(`docs/adr/ADR-0035-tile-art-is-authored-and-resolved-by-level.md`). Every field
it adds has a default, so a version-1 file still parses and draws its colours.

**Version 3** adds the **flat** view — `art.flat` on a tile, `art.flatHeight` on
the set — which is what a top-down world is drawn from
(`docs/adr/ADR-0037-a-flat-map-is-drawn-from-flat-art.md`). `flatHeight` is
**required** wherever a set declares an `art` block at all, so a version-2 file
that declared a grid no longer parses; adding the one line fixes it. The shipped
files say `3`.

### TileArtGeometry

| Field | Type | Default | Meaning |
|---|---|---|---|
| `width` | integer | `32` | Width of every image in the set, in authored pixels. |
| `flatHeight` | integer | `37` | Height of a flat image: the **untilted** hexagon's bounding box, `width * 2 / sqrt(3)`. |
| `surfaceHeight` | integer | `20` | Height of a surface image: the projected top face's bounding box. |
| `elevationHeight` | integer | `13` | Height of an elevation image: the `V` the lower edges cut, then the faces. |
| `elevationStep` | integer | `8` | Authored pixels one level of relief lifts a tile. |

The shipped set draws at **64 x 74 flats, 64 x 40 surfaces and 64 x 26 faces**,
which is the defaults' ratios at twice the resolution — so there is four times
the room to draw in — and lifts a cell by **8 px per level**, half the 16-pixel
band those faces fill — so one image spans two levels and the relief reads at
half height with the art unchanged; see the band and the step below.

All five are `1..512`. The defaults apply only when a set declares no `art`
block at all; a set that declares one must give every field, `flatHeight`
included.

A **flat** image is the whole hexagon seen straight down, and is what a
`topDown` world draws. A **surface** image is the projected top face's bounding
box, and an **elevation** image is the side faces *alone*: its first row is the
hexagon's lower shoulder line, so its top `surfaceHeight / 4` rows are the `V`
the two lower edges cut.

```text
  surface image            elevation image                flat image
  ┌───────────────┐        ┌───────────────┐  ←           ┌───────────────┐
  │      ___      │        │\             /│  surfaceH/4  │      /\       │
  │    /     \    │        │ \___________/ │  ←           │    /    \     │
  │   |       |   │        │  \ SW | SE /  │  one step    │   |      |    │
  │    \_____/    │        │   \___|___/   │  ←           │    \    /     │
  └───────────────┘        └───────────────┘              │      \/       │
                                                          └───────────────┘
   the tilted top face      the two side faces             the hexagon itself,
   (isometric worlds)       (isometric worlds)             untilted (topDown)
```

**A projection draws one of the two, never both.** A `topDown` world draws the
flat image and no relief at all; an `isometric` world draws the surface with the
cliff stacked under it. Neither is ever scaled, squashed or composed to fit the
other's outline — that is what makes them two images
(`docs/adr/ADR-0037-a-flat-map-is-drawn-from-flat-art.md`). A tile with no art
for the projection in force draws its `fallbackColor`, exactly as a tile with no
art at all does.

**What is drawn is a band, not the rest of the canvas.** The faces fill
`elevationHeight − surfaceHeight / 4` rows — everything under the `V` — and
their lower edge follows the same `V` as their upper one, which is the outline
the asset editor's guides mark. Painting outside it paints an **overhang**:
layers still stack, but the lowest one ends on a flat cut instead of on the
hexagon's silhouette, and it juts past the `fallbackColor` wall it is meant to
cover. Wherever the ground continues in front of the cliff the next row's top
face hides that; at the edge of the map, or beside a neighbour standing higher
than the cliff's foot, it does not.

**The band is not the step, and a stack is made of bands.** `elevationStep` is
how far one level *lifts* a cell, and it may be shorter than the band the artist
drew. One image then spans several levels rather than being sliced: a cliff
draws **one image per band**, not one per level, where a band covers

```text
  bandLevels = floor(faceHeight / elevationStep)      at least 1
```

levels of elevation. The shipped set is a 16-pixel band lifted 8 pixels a level,
so `bandLevels` is `2`: three levels of relief are one whole image and half of
the next, and the same art draws a cliff half as tall as it used to without one
asset being redrawn or one row of it repeating.

Bands are stacked **from the foot up**, so the lowest one ends on the hexagon's
own silhouette whatever the cell's height, and the topmost may start *above* the
top face — which is drawn last and covers it. That is why a layer's `drop` is
signed (`docs/adr/ADR-0041-a-cliff-is-stacked-in-bands.md`). Which ladder level a band draws is its index from the ground
(`floor(base / bandLevels) + n`), so a cliff standing on higher ground shows the
stratum its taller neighbour shows at that height. A step *equal* to the band —
the common case, and the defaults — makes `bandLevels` `1`, one image per level,
and every number above collapses to what it always was.

`elevationHeight` must exceed `surfaceHeight / 4`, or there is no room for a
face; and an `elevationStep` taller than the band stacks levels with a gap,
which is a warning rather than an error.

**This is also where the isometric projection comes from.** The renderer derives
its tilt from `surfaceHeight / width` and its per-level lift from
`elevationStep / width`, so a tile drawn from images and a tile filled with
`fallbackColor` cannot disagree about the shape of a hexagon on the same map.
ADR-0016's constants are no longer the source of those two numbers.

### TileDefinition

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Stable id, unique in the set. Referenced by placed tiles. |
| `name` | string | no | Editor label; defaults to `id`. |
| `terrain` | string | yes | Terrain family. Several tiles may share one (`grass`, `water`, …). |
| `movementCost` | integer | yes | Cost of entering. **`0` means impassable.** |
| `tags` | string[] | no | Free-form gameplay tags. |
| `visual.visualId` | string | yes | Stable id the renderer resolves through its sprite registry. |
| `visual.fallbackColor` | string | yes | CSS colour drawn when no sprite is registered for `visualId`. |
| `visual.hints` | object | no | Renderer hints, reserved. |
| `art` | TileArt | no | The images the tile is drawn from. Absent draws `visual.fallbackColor`. |

**Why one `movementCost` and no `passable` flag.** Two fields can disagree; one
cannot. `0` is the impassable sentinel, and passability is derived from it.

**Why a colour in content.** `visualId` is the real reference; `fallbackColor`
is what a tile with no art is drawn with, and what any tile is drawn with while
its images load. Rendering *logic* never appears in content.

### TileArt

```json
"art": {
  "flat": [
    { "id": "a", "asset": "assets/tiles/dirt/flat/dirt_a.png" },
    { "id": "b", "asset": "assets/tiles/dirt/flat/dirt_b.png" }
  ],
  "surface": [
    { "id": "a", "asset": "assets/tiles/dirt/surfaces/dirt_a.png" },
    { "id": "b", "asset": "assets/tiles/dirt/surfaces/dirt_b.png" }
  ],
  "elevation": {
    "levels": [
      { "name": "topsoil", "variants": [{ "id": "a", "asset": "assets/tiles/dirt/elevation/level_1/dirt_a.png" }] },
      { "name": "packed earth", "variants": [{ "id": "a", "asset": "assets/tiles/dirt/elevation/level_2/dirt_a.png" }] }
    ],
    "repeat": { "level": 2 }
  }
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `flat` | TileArtVariant[] | no | Images for the untilted hexagon. `topDown` worlds only. At most 16. |
| `surface` | TileArtVariant[] | no | Images for the tilted top face. `isometric` worlds only. At most 16. |
| `elevation.levels` | ElevationLevel[] | no | Explicit levels; index `i` is level `i + 1`. At most 32. |
| `elevation.repeat` | ElevationRepeat | no | What draws levels above the last explicit one. |

A tile may author one view, both, or neither. Whatever the world's projection
finds nothing for is drawn in `fallbackColor` — a top-down map of tiles that
only drew surfaces is entirely colour, on purpose
(`docs/adr/ADR-0037-a-flat-map-is-drawn-from-flat-art.md`).

A `TileArtVariant` is `{ "id", "asset" }`: an id unique within its list, and a
path under the content root. An `ElevationLevel` is `{ "name"?, "variants" }`
and must declare at least one variant.

`ElevationRepeat` is one of:

| Form | Meaning |
|---|---|
| absent | Levels above the explicit ones reuse the highest explicit level. |
| `{ "level": n }` | They all reuse level `n`. |
| `{ "pattern": [a, b, …] }` | They cycle through those levels, in order. |

**Level 0 is the surface.** Level `n` is **one image** holding the faces the
projection exposes, and only those: a cell's top face always comes from its
`surface` variants, at every height, so raising a tile never costs it the
variety its surfaces give it. Nothing in the engine rotates, mirrors, skews or
scales any part of an image to produce another part; a face that must differ
from its neighbour is a face an artist draws (ADR-0035). This engine's hexagons
are pointy-top (ADR-0014), so a raised tile exposes a **south-west** and a
**south-east** face meeting at its south vertex.

**Resolution.** A cell of height `h` standing over a base of `b` — the lower of
its two front neighbours — draws `ceil((h − b) / bandLevels)` face layers,
capped at 64 and counted from its foot, with its surface over them. Band `n` is
the image of `sourceLevel(floor(b / bandLevels) + n)`, placed at the hexagon's
lower shoulder line and moved down `(h − b) − n × bandLevels` steps — a negative
number for a topmost band that overshoots the top face. The whole image moves;
nothing inside it is transformed.

Which **surface** variant a cell takes — or which **flat** one, in a top-down
world; the same index serves both lists and wraps when they are different
lengths — is fixed by `variantRoll(col, row, tileId)`, an FNV-1a hash rather
than an RNG, so a cell keeps the same face from frame to frame and from session
to session, and no seed travels with the map. Its **faces** then
take the same variant, at every level of the drop: a cell showing `grass_f` is
undercut by `dirt_f` all the way down, so a cliff reads as one cut through one
hillside rather than as courses of masonry. A level with fewer variants wraps.
A cell may override any of this — see `PlacedTile.art` below
(ADR-0036).

A tile that authors a surface and **no** elevation art still draws its authored
top face; the drop under it is filled with `fallbackColor`, exactly as a tile
with no art at all is. The same holds for the part of a drop past the 64-layer
cap. Art covers what it covers, and colour goes behind the rest — a raised cell
never shows a hole.

**The shipped art.** `content/assets/tiles/` holds **eight flats and eight
surfaces for each of the seven terrains** — grass, dirt, sand, water, forest,
rock, mountain — and **three ladders**, for dirt, rock and mountain, at three
levels of eight variants each. 184 images, filed one directory per tile:

```text
assets/tiles/dirt/flat/dirt_a.png
assets/tiles/dirt/surfaces/dirt_a.png
assets/tiles/dirt/elevation/level_1/dirt_a.png
assets/tiles/dirt/elevation/level_2/dirt_a.png
```

Three ladders for seven terrains is deliberate: a cell borrows one when it needs
one (`PlacedTile.art.elevationTile`), so a sand shelf is dirt's cut and a grass
mesa is rock's, without a second set of images (ADR-0036).

A flat and a surface of the same letter are the **same drawing on a different
outline**: the generator swaps the hexagon it masks to and keeps the material,
the noise and everything scattered over it, so grass is the same grass in both
views. Only the shape and the canvas height differ.

Surfaces and flats carry **no gradient and no rim**. Six hexes meet edge to edge
on a map, so a light-to-dark ramp inside one tile becomes a diagonal seam across
the whole field and a shaded border becomes a honeycomb; the variation is value-noise
mottling at a few pixels' scale plus whatever grows on it. The **faces** are
where the light models anything: they are cut ground — strata parallel to the
edge above, erosion running down, stones the size the material carries, and a
hard shadow where the surface overhangs — and the south-west face is lit while
the south-east one is in shadow.

It was all drawn once by `scripts/generate-tile-art.mjs` and is ordinary art from
then on: the asset editor opens it, paints it and writes it back. Nothing in the
build runs that script, and re-running it overwrites whatever has been painted
since.

---

## WorldDefinition

```json
{
  "id": "demo_world",
  "schemaVersion": 6,
  "name": "Demo Valley",
  "zone": "valley",
  "origin": [0, 0],
  "width": 20,
  "height": 20,
  "shape": { "default": "present", "exceptions": [[0, 0], [1, 0]] },
  "orientation": "pointy",
  "projection": "isometric",
  "characterHeightTiles": 2,
  "grid": { "lineWidth": 3, "color": "#336699", "alpha": 0.6 },
  "reveal": { "radius": 1, "opacity": 0.25, "neighbourOpacity": 0.55 },
  "tileSetId": "mvp_terrain",
  "defaultTile": "grass",
  "tiles": [
    { "at": [4, 1], "tile": "mountain", "elevation": 4 },
    { "at": [5, 1], "tile": "mountain", "elevation": 4 }
  ],
  "entities": [
    { "id": "player_1", "templateId": "player", "at": [4, 10], "tags": ["hero"] },
    { "id": "monster_1", "templateId": "monster", "at": [17, 10], "tags": ["hunter"] }
  ],
  "locations": [
    { "id": "loc_camp", "at": [3, 11], "name": "Camp", "tags": ["start", "safe"] }
  ],
  "links": [
    { "id": "link_refuge_door", "at": [3, 10], "targetWorld": "demo_refuge",
      "targetAt": [3, 4], "name": "Refuge", "tags": ["door"] }
  ],
  "metadata": {
    "author": "insulaire",
    "description": "…",
    "updatedAt": "2026-08-16T00:00:00.000Z"
  }
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Stable id. Loading a world replaces any world with the same id. |
| `schemaVersion` | integer | yes | `6`. |
| `name` | string | no | Display name. |
| `zone` | string | no | Id of the `ZoneDefinition` this map belongs to. Absent means the project's default zone — never *no* zone; see below. |
| `origin` | `[col, row]` | no | North-west corner of the extent; the coordinate stored at buffer index `0`. Defaults to `[0, 0]`. May be negative. |
| `width`, `height` | integer | yes | Columns and rows **of the extent**. `1..2048`. Not the size of the world; see `shape`. |
| `shape` | MapShape | no | Which of the extent's cells the map has. Absent is the full rectangle. |
| `orientation` | `"pointy"` \| `"flat"` | no | Defaults to `"pointy"`. `"flat"` is reserved and currently rejected. |
| `projection` | `"topDown"` \| `"isometric"` | no | Defaults to `"topDown"`. How the renderer draws this world; see below. |
| `characterHeightTiles` | number | no | Defaults to `2`; must be `0.25..=8`. Projected tile-face heights occupied by a 128-pixel character canvas. |
| `grid` | object | no | Grid appearance shared by editor and Play. Defaults to `{ "lineWidth": 1, "color": "#000000", "alpha": 0.25 }`. |
| `reveal` | object | no | How far relief may be seen through around the pointer. Defaults to `{ "radius": 1, "opacity": 0.25, "neighbourOpacity": 0.55 }`. |
| `tileSetId` | string | yes | The `TileSetDefinition` this world paints with. |
| `defaultTile` | string | yes | Tile used for every cell not listed in `tiles`. |
| `tiles` | PlacedTile[] | no | Only the cells that differ from `defaultTile`. |
| `entities` | EntityDefinition[] | no | Placed entities. Exactly one player is required to play. |
| `decorations` | PlacedDecoration[] | no | Trees, houses and chests standing on the map. Several may share a cell. |
| `locations` | LocationDefinition[] | no | Points of interest. |
| `links` | MapLink[] | no | Cells that send the player to another map. |
| `metadata` | object | no | Free text; never read by the simulation. |

### Zones

A zone is a group of maps that belong together, and it is the unit of *simulated
scope*: a tick advances the maps of the player's zone, not only the map they
stand on (ADR-0021 — the zone-wide tick is not implemented yet; the grouping it
will read is).

Zones are declared by the **project**, not by the maps: `zone` names a
`ZoneDefinition.id` from `project.json`, exactly as `targetWorld` names another
world. Every map belongs to exactly one:

| The world file says | The map is in |
|---|---|
| `"zone": "valley"` | `valley`, which the project must declare |
| nothing, or `""` | the project's **default** zone — the first it declares, or the implicit `default` when it declares none |

There is no "unzoned" state. An absent zone is written out as nothing, so a file
authored before the field existed round-trips byte for byte and lands in the
default zone.

A zone id resolves only next to the project that declares it, so it is checked
where map links are: `world.unknownZone` comes from the project-wide validation,
`project.duplicateZone` and `project.missingZoneId` from the manifest's own.

### Sparse storage

`tiles` lists **only** the cells that differ from `defaultTile`. A 20x20 demo
world with a lake and a ridge is 82 lines rather than 400, and painting one hex
changes one line of the diff. The runtime expands this into a dense buffer on
load; the editor re-sparsifies on export.

### MapShape

`shape` says which cells of the extent the map has, the same way `defaultTile`
and `tiles` say what they are painted with: a default plus the cells that differ.

```json
"shape": { "default": "absent", "exceptions": [[3, 0], [4, 0], [4, 1]] }
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `default` | `"present"` \| `"absent"` | no | What a cell is when `exceptions` does not name it. Defaults to `"present"`. |
| `exceptions` | `[col, row][]` | no | The cells that are the opposite of `default`. Must lie inside the extent, and none may appear twice. |

The two forms are opposites, and an author reaches a shape by whichever is
shorter: carving a coastline out of a full canvas lists holes
(`"default": "present"`), drawing an archipelago on an empty one lists hexes
(`"default": "absent"`). The editor writes whichever list is shorter, one cell
per line. **Omitting `shape` entirely is the full rectangle**, which is what
every world authored before schema version 4 means.

A cell the map does not have is outside the map in every sense that matters: it
is not drawn, not walkable, and a move onto it is rejected with the same
`outOfBounds` a coordinate beyond the extent gets. Nothing authored may stand on
one — `entity.absentCell`, `location.absentCell`, `link.absentCell`,
`link.absentTargetCell` — and a map with no hex left is `world.emptyShape`.

**Paint survives under a hole.** Carving a cell out does not clear its `tiles`
entry, its elevation or its art choice, so restoring the hex restores what was
there. A painted absent cell is reported as the *warning* `tile.absentCell`,
never an error.

**Connectivity is never checked.** Three rocks off the western shore are a
legitimate map (`docs/adr/ADR-0046-a-map-is-a-set-of-hexes.md`).

### Presentation: projection, character scale, grid and reveal

`projection` is **presentation carried by content**. The simulation never reads
it and no rule may depend on it; it decides how the renderer draws the map, and
it travels to the UI on `WorldView.projection`
(`docs/adr/ADR-0016-isometric-projection.md`).

`characterHeightTiles` is presentation carried the same way. Its reference is a
128-pixel character canvas: at the default `2`, the shipped 64×128 human stands
about two projected tile faces high. Canvas sizes keep their authored relative
scale, so a 32-pixel creature is one quarter as tall and a 256-pixel creature
twice as tall. The map editor exposes the ratio; the renderer receives it on
`WorldView.characterHeightTiles`
(`docs/adr/ADR-0044-map-entity-presentation.md`).

`grid` authors the stroke used whenever the grid is visible in the editor or in
Play. `lineWidth` is an integer from `1` to `4`, expressed in **screen pixels**:
camera zoom therefore never makes it look thicker or thinner. `color` is a
six-digit RGB colour (`#rrggbb`) and `alpha` is its opacity from `0` to `1`.
Visibility itself remains a local toggle, so a player can hide the grid without
rewriting the map. An absent `grid` block receives the former renderer defaults
and is omitted again by canonical serialisation.

`reveal` authors how far relief may be seen through. In an isometric world a
raised cell is drawn over the rows behind it, and past about four levels it
covers a hex entirely; whenever the pointer rests on such a **buried** hex, the
renderer draws whatever stands in front of it see-through
(`docs/adr/ADR-0047-relief-never-hides-a-hex.md`).

| Field | Meaning |
|---|---|
| `radius` | Hex rings around the pointed-at hex revealed with it. Integer `0..=6`; `0` reveals it alone. |
| `opacity` | How solidly the relief in front of the pointed-at hex is drawn, `0..=1`. `1` reveals nothing. |
| `neighbourOpacity` | The same for the relief in front of the ring around it. |

Both opacities are those of **what stands in the way**, not of the hex behind
it. Neither should normally be `0`: a cell drawn away entirely takes its
silhouette with it, and where nothing stands behind it that is a hole in the map
rather than a hex seen through. Everything a see-through cell carries — its grid
outline, its overlay, its markers, whoever stands on it — is drawn at the same
opacity.

The dials belong to the map because how tall its relief is decides how much of
it hides its own hexes; all three are ignored in a top-down world, which hides
nothing. An absent `reveal` block receives
`{ "radius": 1, "opacity": 0.25, "neighbourOpacity": 0.55 }` and is omitted
again by canonical serialisation.

| Value | What it draws |
|---|---|
| `"topDown"` | The hex plane straight down. `elevation` has no visible effect. |
| `"isometric"` | The hex plane foreshortened vertically, with elevated cells lifted off their row and drawn with a side face. |

`elevation` is likewise presentation only in the MVP: nothing about movement,
passability or line of sight reads it. It is packed as **one signed byte per
cell**, so it is constrained to `-128..=127` — outside that, validation reports
`tile.elevationOutOfRange`.

A cell carrying elevation is written to `tiles` even when its tile *is* the
`defaultTile`, because the sparse array is the only place elevation can be
stored.

### PlacedTile

| Field | Type | Required | Meaning |
|---|---|---|---|
| `at` | `[col, row]` | yes | Position. Must be in bounds and unique. |
| `tile` | string | yes | A `TileDefinition.id` from the referenced tile set. |
| `elevation` | integer | no | `-128..=127` steps of relief. Drawn in `isometric`, ignored by the rules. Omitted when `0`. |
| `tags` | string[] | no | Per-cell tags, in addition to the tile's own. |
| `art` | PlacedTileArt | no | What this cell is drawn with. Omitted when it chooses nothing. |

### PlacedTileArt

```json
{ "at": [4, 1], "tile": "grass", "elevation": 2, "art": { "surface": "f", "elevationTile": "rock" } }
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `surface` | string | no | Id of a surface variant of **this cell's own tile**. Absent rolls one. |
| `elevationTile` | string | no | Id of the `TileDefinition` whose elevation ladder cuts the faces. Absent uses the cell's own tile. |
| `elevation` | string | no | Id of the elevation variant, in whichever ladder ends up drawing. Absent follows `surface`. |

**Presentation only**, exactly like `elevation` beside it: no rule reads it and
no rule may. It says which *picture*, never what a tile *is* — terrain, cost,
tags and passability all still come from the `TileDefinition` (ADR-0036).

`elevationTile` is how a meadow stands on a rock cliff: the faces come from the
named tile's ladder and the top face stays the cell's own grass. A cell may
borrow a ladder its own tile does not have, and borrowing from a tile that has
none draws no faces at all — which is reported as `tile.elevationTileWithoutLadder`.

**By id, resolved once.** The renderer works in indices; the search that turns
an id into one happens when the world is flattened, and travels to the UI on
`WorldView.artChoices` (`docs/wasm-api.md`). An id nobody defines resolves to
nothing, and the cell rolls that field as it always would: the four issue codes
below are **warnings**, so a map that lost a variant to a repainted tile set
still loads and still plays.

A cell carrying only an `art` block is written to `tiles` even when its tile *is*
the `defaultTile`, for the same reason `elevation` is: the sparse array is the
only place it can be stored.

### EntityDefinition

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Stable id, unique within the world. |
| `templateId` | string | yes | `"player"` or `"monster"` (see below). |
| `at` | `[col, row]` | yes | Position. Must be in bounds and on a passable tile. |
| `tags` | string[] | no | Free-form tags, carried into the runtime. |
| `properties` | object | no | Opaque to MVP rules; preserved by the editor and loader. `previewCharacter`, when present, is the character id drawn for this entity in the map editor only. |

`properties.previewCharacter` is an authoring preview, not gameplay appearance.
The map editor offers player-category definitions for a `player`, and enemy or
monster definitions for a `monster`; a missing or unreadable id falls back to
the `@` or `M` marker. Play deliberately ignores the player's value and resolves
the character selected by the authored character-creation workflow. Each
monster keeps its own preview value so distinct models can be placed once those
definitions exist. This convention uses the already-open `properties` object,
so it does not change `WORLD_SCHEMA_VERSION`.

### PlacedDecoration

One decoration standing on one cell (ADR-0051). Several may share a hex — that
is what decorations are for — and author order breaks a tie between two drawn
from the same definition.

```json
{ "id": "oak_0", "decoration": "oak", "at": [4, 7], "offset": [-6, 2], "interactive": true }
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Stable id, unique within the world. **What a scenario addresses.** |
| `decoration` | string | yes | Id of the `DecorationDefinition` this is drawn from. |
| `at` | `[col, row]` | yes | Position. Must be in bounds and on a hex the map has. |
| `offset` | `[x, y]` | no | Whole-pixel nudge from where the definition's anchor puts it, `-256..=256` per axis. Positive is right and down. Defaults to `[0, 0]`. |
| `interactive` | boolean | no | Whether a player may interact with **this** one. Defaults to `false`. |
| `tags` | string[] | no | Free-form tags. |

`offset` is *where on the hex* this one sits. The definition's `anchor` is where
a tree belongs; the nudge is the few pixels that keep a row of the same fence
post from reading as a stamped pattern, and it is per placement because that is
the only thing that differs between two trees drawn from one definition. It is
measured in the tile set's authored pixels, like every other length in the
format, and it is **added to** `placement` — the definition is never edited by
placing it.

`interactive` lives here rather than on the definition because it is a fact
about the chest standing at `[4, 7]`, not about chests: one in ten holds the
letter and the other nine are scenery. *Whether*, never *what* — what happens
when it is opened is scenario content (ADR-0005).

Whether `decoration` names a definition that exists is a **project-level**
question, like a link's `targetWorld`: a world file is validated on its own and
cannot know, so the unresolved reference is reported as
`decoration.unknownDefinition` when the project loads.

### LocationDefinition

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Stable id, unique within the world. |
| `at` | `[col, row]` | yes | Position. Must be in bounds. |
| `name` | string | no | Display name. |
| `tags` | string[] | no | Free-form tags. |

### MapLink

A cell that sends the player to another map (ADR-0017). It is the only
cross-file reference in the world schema.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Stable id, unique within the world. |
| `at` | `[col, row]` | yes | The cell that triggers it. Must be in bounds and passable. |
| `targetWorld` | string | yes | Id of the world to enter. May be this world's own id. |
| `targetAt` | `[col, row]` | yes | Where the player arrives there. |
| `trigger` | `"enter"` \| `"interact"` | no | Defaults to `"enter"`. `"interact"` is reserved and currently rejected. |
| `name` | string | no | Display name, drawn under the door marker. |
| `tags` | string[] | no | Free-form tags. |

A link fires when the player's move **ends on** `at` — not while standing there,
so arriving on a door (which is what the door on the other side does) does not
send the player straight back. The target map supplies its own player entity;
the arriving player takes its place at `targetAt`, and the session's tick and
RNG stream carry over.

Because `targetWorld` names another file, a single world validates without it
(see `validateLinks` in `docs/wasm-api.md`).

---

## ProjectDefinition

`content/project.json` says which files make up one game and where a session
starts. It is what a delivered client build boots from (ADR-0018).

```json
{
  "id": "insulaire",
  "schemaVersion": 1,
  "name": "Insulaire",
  "startWorld": "demo_world",
  "zones": [
    { "id": "valley", "name": "Valley" }
  ],
  "tileSets": [
    { "id": "mvp_terrain", "path": "tilesets/mvp_terrain.json" }
  ],
  "worlds": [
    { "id": "demo_world", "path": "worlds/demo_world.json" },
    { "id": "demo_refuge", "path": "worlds/demo_refuge.json" }
  ],
  "characters": [
    { "id": "human_player", "path": "characters/human_player.json" }
  ],
  "decorations": [
    { "id": "torch", "path": "decorations/torch.json" }
  ],
  "objects": [
    { "id": "small_potion", "path": "objects/small_potion.json" }
  ],
  "characterCreation": { "id": "new_game", "path": "character-creation.json" },
  "titleScreen": { "id": "main", "path": "menu/title-screen.json" },
  "settings": { "id": "insulaire_game", "path": "settings.json" },
  "locales": {
    "default": "en",
    "languages": [
      { "id": "en", "name": "English", "files": [{ "id": "menu", "path": "locales/en/menu.json" }] },
      { "id": "fr", "name": "Français", "files": [{ "id": "menu", "path": "locales/fr/menu.json" }] }
    ]
  }
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Stable id. |
| `schemaVersion` | integer | yes | `1`. |
| `name` | string | no | Display name. |
| `startWorld` | string | yes | Id of the world a new session starts on. Must be listed in `worlds`. |
| `zones` | `{ id, name }[]` | no | Zones the maps are grouped into; the **first is the default**. Absent means one implicit `default` zone. See *Zones* above. |
| `tileSets` | `{ id, path }[]` | no | Tile sets to load; `path` is relative to the content root. |
| `worlds` | `{ id, path }[]` | yes | Worlds to load. Every world reachable through a link must be listed. |
| `characters` | `{ id, path }[]` | no | Character definitions to load. See *CharacterDefinition* below. Absent means the project ships none. |
| `decorations` | `{ id, path }[]` | no | Decoration definitions to load. See *DecorationDefinition* below. Absent means the project ships none. |
| `objects` | `{ id, path }[]` | no | Object definitions to load. See *ObjectDefinition* below. Absent means the project ships none. |
| `characterCreation` | `{ id, path }` | no | Generic character-creation choices, characteristics and workflow. See *CharacterCreationDefinition* below. |
| `locales` | `{ default, languages }` | no | Languages the game is available in. See *Locales* below. Absent means the application's own languages, and no content translations. |
| `titleScreen` | `{ id, path }` | no | The screen a client opens on. See *TitleScreenDefinition* below. Absent means the game starts on a map. |
| `settings` | `{ id, path }` | no | The settings this game offers. See *SettingsDefinition* below. The application's own settings are not content. |

Paths are content-root-relative so the same manifest works served from a
subdirectory.

### Locales

Every string a screen displays is a **key**, resolved against the language in
use (ADR-0023). A locale file is a plain nested object of strings, and the
manifest gives it a namespace — its `id` — which prefixes every key in it:

```json
// content/locales/fr/menu.json, declared with "id": "menu"
{
  "title": { "title": "Insulaire", "subtitle": "Un monde hexagonal" },
  "buttons": { "newGame": "Nouvelle partie", "quit": "Quitter" }
}
//  →  menu.title.subtitle, menu.buttons.newGame, menu.buttons.quit
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `locales.default` | string | no | Language a missing translation falls back to. Absent means the first declared. |
| `locales.languages[].id` | string | yes | Language id, ideally a BCP 47 tag (`fr`, `en`, `pt-BR`). |
| `locales.languages[].name` | string | no | Name shown in the picker, written in that language. Defaults to the id. |
| `locales.languages[].files[]` | `{ id, path }[]` | no | Locale files; `id` is the **namespace** prefixed to every key in the file. |

Rules:

- a file holds **strings only** — a number or a boolean is a parse error;
- a key segment may not be empty or contain a dot;
- a key may not be defined twice in one language, whichever file defines it;
- a language the manifest declares must have at least one loaded file, or the
  project does not load;
- a key some language defines but another does not is a **warning**: the default
  language's text is served, and `fallbacks` in the `LocaleView` lists it.

The application ships its own text for the `ui.` namespace in every language it
claims, so the editor is legible with no content loaded. Content may define
`ui.` keys too, and content wins.

---

## TitleScreenDefinition

`content/menu/title-screen.json` is what a delivered client opens on: the
background, the music, and the menu (ADR-0024). Everything visible is authored;
what a button *does* is not — `action` names one of a closed set the application
implements.

```json
{
  "id": "main",
  "schemaVersion": 1,
  "titleKey": "menu.title.title",
  "subtitleKey": "menu.title.subtitle",
  "background": { "image": "assets/images/title.png", "fit": "cover", "tint": "#0b1016" },
  "logo": { "image": "assets/images/logo.png", "maxWidthPercent": 40 },
  "splash": { "image": "assets/images/splash.png", "durationMs": 1200, "skippable": true },
  "music": { "track": "assets/audio/theme.ogg", "loops": true, "gain": 0.8, "fadeInMs": 1500 },
  "theme": { "accent": "#ffd166", "text": "#e8eef5", "panel": "rgba(12,16,22,0.72)", "font": "" },
  "layout": "left",
  "buttons": [
    { "action": "newGame", "labelKey": "menu.buttons.newGame" },
    { "action": "continue", "labelKey": "menu.buttons.continue" },
    { "action": "settings", "labelKey": "menu.buttons.settings" },
    { "action": "quit", "labelKey": "menu.buttons.quit" }
  ]
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Stable id; must match the manifest's `titleScreen.id`. |
| `schemaVersion` | integer | yes | `1`. |
| `titleKey` / `subtitleKey` | string | `titleKey` | Keys, not text. |
| `background.image` | string | no | Content path. Empty means no image; the `tint` is then the whole backdrop. |
| `background.fit` | `cover` \| `contain` \| `tile` | no | Defaults to `cover`. |
| `background.tint` | CSS colour | no | Laid over the image. |
| `logo` | `{ image, maxWidthPercent }` | no | Drawn in place of the title. `maxWidthPercent` is `1..=100`, default `40`. |
| `splash` | `{ image, durationMs, skippable }` | no | Shown once per launch, over the menu. `image` may be empty (the title alone); `skippable` defaults to `true`. |
| `music` | `{ track, loops, gain, fadeInMs }` | no | `gain` is `0..=1` relative to the music volume setting; `loops` defaults to `true`. |
| `theme` | `{ accent, text, panel, font }` | no | CSS values applied as custom properties. |
| `layout` | `left` \| `center` \| `right` | no | Defaults to `left`. |
| `buttons[].action` | `newGame` \| `continue` \| `settings` \| `credits` \| `quit` | yes | What pressing it does. |
| `buttons[].labelKey` | string | yes | Key of the label. |
| `buttons[].hidden` | boolean | no | Authored out without deleting it. |

Rules:

- exactly one visible `newGame` button is required, and an action may not appear
  twice;
- an asset path must be relative to the content root, with no `..` and no URL;
- `durationMs` and `fadeInMs` are capped at 60 000;
- `quit` is dropped by the client outside the desktop shell, and `continue` is
  shown disabled while there is no save — both decided by the application, not
  by the file.

---

## SettingsDefinition

`content/settings.json` declares the settings the **game** offers (ADR-0025).
The application's own — volumes, interface scale, language, window size — are
not here: they configure the shell and are declared in the application. Both use
the same control vocabulary, so one screen renders them together.

```json
{
  "id": "insulaire_game",
  "schemaVersion": 2,
  "sections": [{
    "id": "gameplay", "labelKey": "game.settings.gameplay",
    "groups": [{
      "id": "world", "labelKey": "game.settings.worldGroup",
      "fields": [
        { "id": "population", "labelKey": "game.settings.population",
          "helpKey": "game.settings.populationHelp",
          "control": "slider", "default": 120, "min": 20, "max": 400, "step": 10,
          "scope": "newGame" },
        { "id": "harshWinters", "labelKey": "game.settings.harshWinters",
          "control": "checkbox", "default": true, "scope": "newGame",
          "showIf": { "field": "difficulty", "equals": "harsh" } }
      ]
    }]
  }]
}
```

Sections are tabs, groups are panels, fields are settings.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Stable id; must match the manifest's `settings.id`. |
| `schemaVersion` | integer | yes | `2`. Version 2 adds `keyBinding`. |
| `sections[].id` / `groups[].id` / `fields[].id` | string | yes | Stable ids. A **field** id is the key its value is stored under, and must be unique across the whole file. |
| `*.labelKey`, `fields[].helpKey` | string | `labelKey` | Keys, not text. |
| `fields[].control` | `toggle` \| `checkbox` \| `select` \| `multiSelect` \| `slider` \| `number` \| `text` \| `color` \| `keyBinding` | yes | How it is presented, and therefore what it accepts. `keyBinding` is settings-only. |
| `fields[].default` | any | yes | Must be a value its own control accepts, and within its bounds. |
| `fields[].options[]` | `{ value, labelKey }[]` | for `select`/`multiSelect` | The choices. |
| `fields[].min` / `max` / `step` | number | no | For `slider` and `number`. `step` must be positive. |
| `fields[].unit` | string | no | Shown next to the value, e.g. `%`. Displayed as written, not translated. |
| `fields[].scope` | `session` \| `newGame` | no | `session` (default) applies immediately; `newGame` is frozen while a game runs. |
| `fields[].showIf` | `{ field, equals }` | no | Shows this field only when another holds that value. One field, one value — no expressions. |

Values are **resolved** against the declaration before they are used: defaults
fill the gaps, a value of the wrong type or an option nobody declared falls back
to the default, a number outside its bounds is clamped, and a key the
declaration does not know is dropped. The settings screen and `createGame` both
resolve, so they cannot disagree.

A `keyBinding` value is one modifier-free browser `KeyboardEvent.code`, such as
`"KeyW"`, `"Digit1"` or `"Quote"`. It identifies the physical key position,
not the printed character: `KeyW` is the key labelled `Z` on French AZERTY and
`W` on QWERTY. The settings UI captures that code and uses the active keyboard
layout only for its label (ADR-0045). Character parameters and character
creation controls cannot use `keyBinding`; Escape is reserved to cancel capture
and its `scope` must be `session` so it can be rebound during play.

---

## CharacterCreationDefinition

`content/character-creation.json` defines the initial form and its ordered
player-facing screens (ADR-0042). `CHARACTER_CREATION_SCHEMA_VERSION` is **1**.
The engine reserves no semantic id: `race`, `gender`, `hairLength`, `hp` and
every other name belong to the game.

```json
{
  "id": "new_game",
  "schemaVersion": 1,
  "baseCharacter": "human_player",
  "choices": [
    {
      "id": "hairStyle",
      "labelKey": "game.character.hairStyle",
      "control": "select",
      "default": "short",
      "options": [
        { "value": "short", "labelKey": "game.character.hairShort" }
      ],
      "binding": { "kind": "parameter", "parameter": "hairStyle" }
    }
  ],
  "characteristics": [
    { "id": "hp", "labelKey": "game.creation.hp", "control": "number",
      "default": 100, "min": 0, "max": 100, "nullable": false }
  ],
  "screens": [
    { "id": "appearance", "titleKey": "game.creation.appearanceTitle",
      "transition": "fade", "blocks": [
        { "type": "choice", "choice": "hairStyle" },
        { "type": "preview", "animation": "idle",
          "parameters": { "armor": "plate" } },
        { "type": "summary" }
      ] }
  ]
}
```

`choices[]` are `ControlDefinition`s without a meaningful `scope`. A binding is
either `{ "kind": "character" }`, whose selected string is a character id, or
`{ "kind": "parameter", "parameter": "…" }`, which forwards the value to
that parameter of the resolved character. A select authors its own `options`,
so it may expose a strict subset of what the resource editor permits. A colour,
number or slider forwards the dynamic value. Numeric creation ranges may narrow
the resource range but may not widen it.

`showIf: { field, equals }` may refer only to a choice declared **earlier**.
Hidden choices do not contribute a parameter or replace the character.

`characteristics[]` use the same controls but are stored independently of
appearance. `nullable: true` permits JSON `null`, including as the default.
For numeric controls, absent `min` is −∞ and absent `max` is +∞: omitting both
is unbounded, naming only `min: 0` is `0..+∞`, and two authored bounds are a
custom range. `select` is an enum, boolean controls are booleans, and `text` is
free text.

`screens[]` are traversed in order. When the declaration is present, **New
game** opens this workflow before the play route; a project that declares no
character creation keeps starting play directly. Their `transition` is `none`,
`fade`, `slideLeft` or `slideUp`. Blocks are:

| `type` | Fields | Meaning |
|---|---|---|
| `text` | `textKey` | Localised paragraph. |
| `choice` | `choice` | A declared creation choice. |
| `characteristic` | `characteristic` | A declared player characteristic. |
| `preview` | `animation?`, `parameters?` | Real character preview. Parameters are temporary overrides, useful for equipment previews without making equipment a creation choice. |
| `summary` | — | Recap of the generic resolved result. |

Resolution returns `{ character, choices, parameters, characteristics }`. The
engine applies defaults, backwards conditions and declared bindings; it never
interprets an id. This declaration is authored and resolved today, but the
result is not yet carried by `GameState` or saves.

Validation issue codes use the `characterCreation.` prefix: header and source
errors (`missingId`, `unsupportedSchemaVersion`, `noCharacterSource`,
`unknownCharacter`), choice and binding errors (`missingChoiceId`,
`duplicateChoice`, `forwardCondition`, `characterBindingNeedsSelect`,
`missingParameter`, `unknownParameter`, `incompatibleParameter`,
`unknownParameterValue`), characteristic errors (`missingCharacteristicId`,
`duplicateCharacteristic`, `nullDefault`), workflow reference errors
(`noScreens`, `missingScreenId`, `duplicateScreen`, `unknownChoice`,
`unknownCharacteristic`), and non-blocking visibility warnings
(`unknownAnimation`, `unknownPreviewParameter`, `unusedChoice`,
`unusedCharacteristic`). The shared control errors (`invalidDefault`,
`defaultOutOfRange`, `emptyRange`, `invalidStep`, `noOptions`, …) carry the
same prefix.

---

## CharacterDefinition

`content/characters/*.json` describes **how a kind of character is drawn, and
what may be chosen about one** (ADR-0028). The player's character is one of
them; an NPC, a monster or a boss is another, and nothing in the format is
specific to any of those.

A character is **composed of sprites** on a pixel canvas it declares
(ADR-0029). There is no procedural drawing vocabulary: a layer names an image.

Its layers also form a **tree**: a layer hangs off a joint on another one and is
**placed from there** (ADR-0034), and **animations** move nodes of that tree by
whole pixels over time (ADR-0031). Both are optional — a definition of roots and
no animation is a flat stack of sprites, which is how it started.
An animation may also declare the gameplay **role** it serves, so the runtime
never guesses meaning from an author-owned id (ADR-0043).

```json
{
  "id": "human_player",
  "schemaVersion": 3,
  "name": "Human Player",
  "category": "player",
  "resolution": { "width": 64, "height": 128 },
  "parameters": [
    {
      "id": "hairColor",
      "labelKey": "game.character.hairColor",
      "control": "color",
      "default": "#8b5a2b"
    }
  ],
  "layers": [
    {
      "id": "hairFront",
      "variants": [
        { "id": "default", "rect": [23, 10, 18, 20], "sprite": { "asset": "assets/characters/hair_front.png", "tint": { "parameter": "hairColor" } } }
      ]
    }
  ]
}
```

A definition plus a set of chosen values is resolved into a flat, ordered list
of sprites to blit:

```text
CharacterDefinition + values ──> resolve() ──> ResolvedCharacter ──> renderer
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Stable id; must match the manifest's entry. |
| `schemaVersion` | integer | yes | `3` — anchor-relative boxes (ADR-0034). `2` was ADR-0029's absolute ones; `1` was ADR-0028's primitives on a unit square. Both are gone. |
| `name` | string | no | Shown in the editor. Not player-facing, so not a key. |
| `category` | `player` \| `npc` \| `enemy` \| `monster` \| `other` | no | Filing only. **Never read by the resolver or the renderer.** Default `other`. |
| `resolution` | `{ width, height }` | no | The pixel canvas the sprites are authored on, `1..=256` a side. Default `64 × 128`. |
| `parameters[]` | `ControlDefinition[]` | no | The choices it offers. A definition may offer none. |
| `layers[]` | see below | no | The pieces it is drawn from, **back to front**. |
| `animations[]` | see below | no | The movements it can play. Absent means it never moves. |

### The canvas

`resolution` is what a character's size *is*. A rat is authored at 32×32 and a
dragon at 256×256; a host draws each at its native size times a **whole-number**
zoom, so authored pixels stay square. There is no scale factor in the format —
scaling pixel art by 1.15 is how pixel art stops being pixel art.

### Parameters

A parameter **is** a `ControlDefinition` — the same vocabulary as
*SettingsDefinition* above, and resolved by the same rule: defaults fill the
gaps, a wrong type or an undeclared option falls back to the default, a number
outside its bounds is clamped, and an unknown key is dropped.

`scope` is **not part of this format**: it says when a *setting* may change, and
means nothing to a character. The editor never writes it and the engine never
reads it here.

### Layers and variants

| Field | Type | Required | Meaning |
|---|---|---|---|
| `layers[].id` | string | yes | Stable id, unique in the definition. |
| `layers[].parent` | string | no | Id of the layer this one hangs off. Absent makes it a root. **Not the draw order** — see *The skeleton* below. |
| `layers[].parentAnchor` | string | no | Which of the parent's `anchors` it hangs off, and is **placed from**. Absent measures from the parent's own origin. |
| `layers[].anchors[]` | `{ id, at: [x, y] }[]` | no | Named points other layers hang off, measured from **this layer's own origin**. |
| `layers[].variants[]` | see below | no | The appearances it can take, **most specific first**. |
| `variants[].id` | string | yes | Stable id, unique within its layer. |
| `variants[].when` | `{ parameterId: value }` | no | Values this variant requires. Absent means "always". |
| `variants[].rect` | `[x, y, width, height]` | no | Where the sprite goes, in **whole pixels**, measured from the joint its layer hangs off. `x`/`y` are commonly negative. |
| `variants[].order` | integer | no | Where this variant draws in the stack, overriding the author order. Default `0`. See *Draw order*. |
| `variants[].sprite` | `{ asset, tint? }` | yes | The image it draws. |

**The first variant whose conditions hold is the one drawn**, so author order is
priority. A layer with no matching variant draws nothing, which is how an
optional piece — a cape, a helmet — is authored.

Every entry of `when` must match. A parameter holding a **list** matches a
scalar it *contains*, so `{ "equipment": "helmet" }` asks whether a helmet was
chosen among several.

`rect` is the sprite's box, and its `width`/`height` should be the image's own
pixel size — any other size stretches it — which the editor fills in from the
image when one is picked. Its `x`/`y` are measured from **the joint its layer
hangs off**, not from the canvas, so a sprite drawn to sit exactly on that joint
is `[0, 0, width, height]` and negative values are ordinary (see *The
skeleton*). A box that *lands* outside the canvas is legal — a cape overhangs —
and reported as a warning.

### Sprites and tints

```json
"sprite": { "asset": "assets/characters/hair_front.png" }
"sprite": { "asset": "assets/characters/hair_front.png", "tint": { "parameter": "hairColor" } }
"sprite": { "asset": "assets/characters/cape.png", "tint": { "fixed": "#4e8f74" } }
```

| Field | Type | Meaning |
|---|---|---|
| `asset` | string | Path under the content root. No URLs, no `..`, no absolute paths. |
| `tint` | `{ "fixed": css }` or `{ "parameter": id }` | Recolours the sprite. Absent draws it as authored. |

A tint **multiplies** the sprite and keeps its alpha, so a near-white sprite
becomes the tint with its own shading intact. That is what lets one greyscale
hair sprite serve every hair colour instead of one image per colour. A
`parameter` tint whose value is not a string draws as `#ff00ff`.

### The skeleton

`parent` makes the layers a **tree**, and the tree **places** the character as
well as animating it (`docs/adr/ADR-0034-layer-boxes-are-anchor-relative.md`):

```text
origin(root)  = the canvas origin
origin(child) = origin(parent) + the anchor it names on that parent
rect          = origin(layer) + the box in the file
anchor.at     = measured from its own layer's origin
```

```json
{ "id": "body", "anchors": [{ "id": "shoulders", "at": [32, 36] }], "variants": [
    { "id": "default", "rect": [21, 12, 22, 54], "sprite": { … } } ] },
{ "id": "top", "parent": "body", "parentAnchor": "shoulders", "variants": [
    { "id": "leather", "rect": [-9, 0, 18, 14], "sprite": { … } } ] }
```

The chest piece is nine pixels left of the shoulders and level with them. Move
the shoulders and it follows; move the body and everything under it follows.
A sprite drawn so its own corner sits on the joint is `[0, 0, w, h]`.

A **root** hangs off nothing, so its box is a canvas position and its anchors
read as canvas coordinates. Every other layer's anchors travel with it.

An animation's offsets compose into the same frames, so a body that drops two
pixels takes the head, the hair and everything hanging off it with it
(ADR-0031). The resolved payload carries the absolute box **and** the `origin`
it was measured from, so a renderer needs none of this and an editor can turn a
click back into the number in the file.

The tree is still **independent of the draw order**. Layers are drawn in author
order, back to front; a cape hangs off the body and is drawn behind it, and the
format keeps those two statements apart — until a variant says otherwise.

A `parent` naming a layer nobody declares, an `anchors` id used twice, a
`parentAnchor` the parent does not declare, and a chain of parents that loops
are all errors. A layer whose `parent` is missing is placed as a root, and one
whose `parentAnchor` is missing is placed at its parent's origin: the file does
not load, but the picture still arrives.

### Draw order

Layers draw back to front in the order they are declared. A **variant** may step
out of that order:

```json
{ "id": "sideWorn", "when": { "cape": true, "view": "side" },
  "rect": [1, -6, 14, 76], "order": 1, "sprite": { … } }
```

Everything sorts by `order` first and by declaration second, stably: `1` draws
over every `0`, `-1` behind, and layers sharing an order keep the file's
sequence. The cape above hangs behind the body normally and drapes over the near
shoulder when the character is seen from the side.

It is on the **variant** because that is where a condition already lives — the
`when` that chose the side-on drawing is the one that moves it forward, and a
customisation can do the same thing (armour worn over a cloak) with no new
vocabulary.

### Animations

An animation is two statements. Its **tracks** say what moves: offsets from the
rest pose, per node, per frame. Its **pose** says what is drawn: values that
join the customisation while it plays, so layers pick their sprites through the
`when` conditions they already have
(`docs/adr/ADR-0033-animations-set-pose-values.md`).

```json
"animations": [
  {
    "id": "idle",
    "name": "Idle",
    "role": "idle",
    "frames": 4,
    "frameDurationMs": 140,
    "looping": true,
    "tracks": [
      {
        "node": "body",
        "keyframes": [
          { "frame": 0, "offset": [0, 0] },
          { "frame": 1, "offset": [0, -1] },
          { "frame": 2, "offset": [0, 0] },
          { "frame": 3, "offset": [0, 1] }
        ]
      }
    ]
  }
]
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Stable id, unique in the definition — `idle`, `walk`, `attack`. |
| `name` | string | no | Shown in the editor. Not player-facing, so not a key. |
| `role` | see below | no | Gameplay situation this animation illustrates. A role may be assigned only once per character. |
| `frames` | integer | yes | How long it is, `1..=240`. |
| `frameDurationMs` | integer | no | How long each frame lasts. Default `120`. |
| `looping` | boolean | no | Whether it starts again when it ends. Default `false`. |
| `tracks[]` | see below | no | What moves, and when. |
| `tracks[].node` | string | yes | Id of the layer this track drives. One track per node. |
| `tracks[].keyframes[]` | see below | no | The values it takes, at the frames it takes them. |
| `keyframes[].frame` | integer | yes | `0`-based, and less than the animation's `frames`. |
| `keyframes[].offset` | `[x, y]` | no | Translation from the rest pose, in **whole pixels**. Default `[0, 0]`. |
| `keyframes[].interpolation` | `step` \| `linear` | no | How it reaches the next keyframe. Default `step`. |
| `pose` | `{ key: value }` | no | Pose values that hold for the whole animation. See *Poses*. |
| `poses[]` | see below | no | Pose values set frame by frame, laid over `pose`. |
| `poses[].frame` | integer | yes | `0`-based, and less than the animation's `frames`. |
| `poses[].<key>` | any JSON scalar | no | A pose value, flattened beside the frame number. `frame` is therefore a reserved key. |

`frames`, `frameDurationMs`, `looping`, `pose`, `poses` and `tracks` are all
absent on a **mirror** — see *Mirrored animations* below.

**A node with no track does not sit still — it follows its parent.** That is the
whole point: the idle above drives one node, and every layer hanging off `body`
moves with it. A character with thirty layers and ten animations stores ten
lists of *what moved*, not three hundred positions.

A node's **global** offset is the sum of the local offsets along the chain from
it up to its root, so a node's own keyframe **adds to** what it inherits: a head
that inherits `-2` and writes `+1` ends at `-1`.

Outside its keyframes a track **holds**: before the first it is the first value,
after the last it is the last. `linear` interpolation still rounds to whole
pixels — it buys smoother timing, never a fractional position — and on a looping
animation it travels from the last keyframe back to the first.

Evaluation takes a **time in milliseconds**, not a frame: a looping animation
wraps, and one that does not stops inside its last frame. There is **no rotation
or scale inside an animation**, because either would resample the layer art
ADR-0029 exists to keep sharp. A map may still apply the single outer character
scale decided by ADR-0044 after resolution.

### Gameplay animation roles

Animation ids remain arbitrary. Gameplay selects the optional `role` instead
(`docs/adr/ADR-0043-gameplay-selects-character-animations-by-role.md`):

| Role | Meaning |
|---|---|
| `idle` | The character is not moving. |
| `moveLeft` / `moveRight` | The two ordinary movement cycles. These are enough to cover all six hex directions. |
| `moveEast`, `moveNorthEast`, `moveNorthWest`, `moveWest`, `moveSouthWest`, `moveSouthEast` | Optional exact-direction overrides. |

For movement, an exact role wins. If none is authored, east, north-east and
south-east use `moveRight`; west, north-west and south-west use `moveLeft`.
When neither exists the character draws its rest pose. An absent `idle` also
draws the rest pose, so gameplay roles are additive and still characters remain
valid.

Gameplay plays one pass of a movement animation and then returns to `idle`.
During that pass the entity also interpolates from the movement event's `from`
cell to its authoritative `to` cell. Monsters and fallback tokens use the same
glide even when they have no character animation. This clock is presentation
state: it neither advances a tick nor enters a save.

### Poses

An animation may set **pose values**, and while it plays they join the resolved
customisation. Nothing reads them directly: a layer picks them up through its
variants' `when`, which is the same mechanism that answers "is a cape worn" or
"what colour is the hair".

```json
{
  "id": "walking_left", "role": "moveLeft",
  "frames": 4, "frameDurationMs": 130, "looping": true,
  "pose": { "view": "side" },
  "poses": [
    { "frame": 0, "step": "contact" },
    { "frame": 1, "step": "pass" },
    { "frame": 2, "step": "contactBack" },
    { "frame": 3, "step": "passBack" }
  ],
  "tracks": [ … ]
}
```

`pose` is what is true of the whole animation; `poses` overrides it frame by
frame. Layers then answer whichever part they have something to say about:

```json
{ "id": "body", "variants": [
  { "id": "side", "when": { "view": "side" }, "rect": [21, 12, 22, 54], "sprite": { … } },
  { "id": "default", "rect": [21, 12, 22, 54], "sprite": { … } } ] },
{ "id": "legs", "variants": [
  { "id": "sideContact", "when": { "step": "contact", "view": "side" }, "sprite": { … } },
  { "id": "sidePass",    "when": { "step": "pass",    "view": "side" }, "sprite": { … } },
  { "id": "stand", "sprite": { … } } ] }
```

The body says `view: side` once and answers every frame; the legs say it once
per drawing, because they *are* four drawings. **The file is as long as the art
is.**

**A `when` key may name a parameter or a pose key, and a variant does not know
which.** `{ "armor": "plate", "view": "side" }` is one condition, half chosen by
the player and half by the animation — which is what lets a pose combine with a
customisation instead of overriding it.

A pose **holds** in both directions, like a hand-drawn sprite rather than a
tween: before the first entry it is the first, after the last it is the last,
and a frame that sets nothing keeps what was set before it. It is never
interpolated.

Two things a pose deliberately cannot do. It never joins the resolved
character's `values` — it is reported separately, on `pose.values`, because it
is what the character is *doing* and not what was chosen about it. And it never
reaches a **tint**, which is resolved from the customisation alone: an animation
redraws a layer, it does not repaint one.

A pose key is an undeclared string. Both directions of the coupling are checked
instead: a `when` naming neither a parameter nor a pose is an error
(`character.unknownConditionParameter`), and a pose key no variant waits on is a
warning (`character.unreadPoseKey`) — otherwise it is invisible, because the
animation plays and nothing happens.

### Mirrored animations

A character walking right walks left the same way, seen the other way round.
Rather than author the second one, an animation may say it **is** the first one
flipped:

```json
{ "id": "walking_right", "name": "Walking right", "role": "moveRight", "mirrorOf": "walking_left" }
```

That is the whole file entry. A mirror takes its source's `frames`,
`frameDurationMs`, `looping`, `tracks` and sprites; **its own are never read**,
and declaring `tracks` on one is a warning (`character.mirrorWithTracks`). What
changes is a single flag on the resolved character: `mirrored`, which asks the
host to draw the whole canvas reflected about its own vertical centre.

Flipping the *boxes* without flipping the pixels inside them would be a
character taken apart and put back wrong, so mirroring is a statement about the
output as a whole rather than a per-layer geometry change.

A mirror of a mirror is refused (`character.chainedMirror`): one hop, never a
chain to walk. A mirror whose source is missing is an error
(`character.unknownMirrorSource`) and still resolves — flipped, at rest.

### ResolvedCharacter

What `resolveCharacter` and `previewCharacter` return, and the only thing a
renderer needs — no lookup, no definition, no customisation:

```json
{
  "character": "human_player",
  "category": "player",
  "resolution": { "width": 64, "height": 128 },
  "values": { "hairColor": "#8b5a2b", "cape": true },
  "layers": [
    { "layer": "hairFront", "variant": "default", "rect": [23, 10, 18, 20],
      "offset": [0, 0],
      "asset": "assets/characters/hair_front.png", "tint": "#8b5a2b" }
  ],
  "mirrored": false,
  "pose": { "animation": "idle", "frame": 1, "timeMs": 140, "durationMs": 560 }
}
```

`pose.durationMs` is the duration of one complete pass, using the source's
timing for a mirror. It lets presentation return from movement to idle without
reimplementing animation timing.

`tint` is **an empty string** when the sprite is drawn as authored — not `null`,
not a colour.

`rect` is where to draw it, **animation included**: the offset is already in it,
which is why the renderer needed no change. `offset` is how far the animation
moved the layer from its rest pose, inherited transforms included — a renderer
ignores it, and an editor uses it to say what the hierarchy did.

`mirrored` asks the host to draw the **whole canvas** flipped left-to-right,
about the canvas's own centre line. It is the only thing a mirrored animation
changes; every box and every sprite is the source animation's.

`pose` is **absent** on a rest pose, and absent when the animation id asked for
is one the definition does not declare — resolving is total, so an editor
previewing a definition mid-edit gets a picture rather than an error.

---

## DecorationDefinition

`content/decorations/*.json` describe **the things that stand on a hex without
being the hex**: a tree, a house, a chest, a bush, a signpost. Several may share
one cell (ADR-0048).

```json
{
  "id": "torch",
  "schemaVersion": 2,
  "name": "Wall torch",
  "category": "prop",
  "resolution": { "width": 16, "height": 32 },
  "anchor": [8, 31],
  "plane": "front",
  "order": 2,
  "animations": [
    {
      "id": "burning",
      "frameDurationMs": 100,
      "looping": true,
      "frames": [
        "assets/decorations/torch_0.png",
        "assets/decorations/torch_1.png"
      ]
    }
  ]
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Stable id, referenced by a placed decoration. |
| `schemaVersion` | integer | yes | `2`. |
| `name` | string | no | Editor label. Not player-facing, so not a key. |
| `category` | enum | no | `nature`, `building`, `prop`, `container`, `other`. Filing only — nothing reads it. |
| `resolution` | `{ width, height }` | no | The canvas every frame is drawn on, at most `256` a side. Defaults to `32x48`. |
| `anchor` | `[x, y]` | no | The pixel of that canvas which lands on the cell's ground point. Defaults to `[0, 0]`. |
| `plane` | enum | no | `behind` (default) or `front` — which side of the characters it is drawn on. |
| `order` | integer | no | Sort key **within its plane**, `-999..=999`. Higher draws later, so over. Defaults to `0`. |
| `tags` | string[] | no | Author-owned gameplay tags. |
| `animations` | `DecorationAnimation[]` | no | The appearances it can play, in author order. |
| `defaultAnimation` | string | no | Which one plays when nothing asks for one. Absent names the first declared. |

**Schema `2` removed `interactive`** (ADR-0051). Whether a thing can be opened
or searched is a fact about the chest standing at `[4, 7]`, so it moved to
`PlacedDecoration`. There is no reader for the old field: a `1` file's
`interactive` is ignored.

### The anchor

A decoration is **anchored, not centred**. `anchor` names the pixel of the image
that sits on the cell's ground point, so a tree anchors at the foot of its trunk
and a hanging lantern at the ring it hangs from. The resolver returns the box
that follows from it — `placement`, `[x, y, width, height]` relative to that
ground point — so no host redoes the subtraction.

The anchor is a position **on the cell**, not a coordinate inside the image. An
anchor outside the decoration's own canvas is therefore ordinary: it is a small
prop dropped away from the middle of its hex, and nothing is reported for it.

What *is* reported is the drawing leaving the hexagon —
`decoration.overflowsCell`, and a **warning**, because a big tree is supposed to
overhang its cell. It needs the cell's pixel grid to measure against, which a
decoration file does not carry: `validateDecoration` takes an optional
`TileArtGeometry` and skips this one check without it, so loading a definition
needs no tile set while the editor, which has one, gets the warning. It is
measured against the **flat** hexagon, the larger of the two footprints a
projection gives a cell.

### The two planes

Depth on one cell is not a single number. A character standing on a hex is *in
front of* the grass and *behind* the tree canopy, so the sort key is the
`plane` first — everything `behind`, then the characters, then everything
`front` — and `order` within each. One combined z-index cannot express that
without the renderer knowing which numbers mean "past the characters", which is
scenario-shaped knowledge the engine must not carry (ADR-0048).

### Appearances are flipbooks

A `DecorationAnimation` is a named, ordered list of images:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Stable id — `idle`, `open`, `burning`. |
| `name` | string | no | Editor label. |
| `frames` | string[] | yes | Image paths under the content root, in play order. At most 64. |
| `frameDurationMs` | integer | no | How long each frame lasts. Defaults to `120`. |
| `looping` | boolean | no | Whether it starts again when it ends. Defaults to `false`. |

One image per frame, played at a fixed rate — not a skeleton with tracks and
poses, which is what a *character* is (see below). A torch has four drawings.

A named appearance is also how a decoration has **states**: a chest declares
`closed` and `open`, each one frame long, and the scenario asks for one by id. A
looping appearance wraps; one that does not holds its last frame, which is what
makes a one-shot state stay in the state it reached.

Nothing in the format says what *interacting* with a decoration does.
`interactive` says **whether**, never **what**; opening a chest and searching a
bush are scenario content (ADR-0005).

### ResolvedDecoration

What `resolveDecoration` / `previewDecoration` return (`docs/wasm-api.md`):
`id`, `resolution`, `anchor`, `placement`, `plane`, `order`, `interactive`, the
`animation` that played, the `frame` index within it, and the `asset` to blit.
`animation` and `asset` are empty when the decoration declares no appearance.

---

## ObjectDefinition

`content/objects/*.json` describe **what a character carries**: inventory items,
equipment, consumables, quest tokens. The sibling of a decoration and its
opposite — a decoration stands on a hex and is drawn in the world, an object
travels in a bag and is drawn in a panel (ADR-0049).

```json
{
  "id": "small_potion",
  "schemaVersion": 2,
  "name": "Small potion",
  "kind": "consumable",
  "nameKey": "game.object.smallPotion.name",
  "descriptionKey": "game.object.smallPotion.description",
  "frames": [
    "assets/objects/small_potion.png"
  ],
  "resolution": { "width": 16, "height": 16 },
  "stackSize": 10,
  "tags": ["healing"]
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Stable id, referenced by inventories and by the scenario. |
| `schemaVersion` | integer | yes | `2`. |
| `name` | string | no | Editor label. Not player-facing, so not a key. |
| `kind` | enum | no | `consumable`, `equipment`, `quest`, `material`, `other`. Filing only. |
| `nameKey` | string | no | Key of the name a player reads (ADR-0023). |
| `descriptionKey` | string | no | Key of the description a player reads. |
| `frames` | string[] | no | The images of the icon, in play order, under the content root. **One frame is a still icon.** At most 64. |
| `frameDurationMs` | integer | no | How long each frame lasts. Defaults to `120`. Unread by a still icon. |
| `looping` | boolean | no | Whether the icon starts again when it ends. Defaults to `false`. |
| `resolution` | `{ width, height }` | no | The canvas every frame is drawn on. Defaults to `32x32`. |
| `stackSize` | integer | no | How many fit in one inventory slot, `1..=9999`. `1` means it does not stack. Defaults to `1`. |
| `slot` | string | no | Where equipment is worn — an author-owned id such as `head` or `mainHand`. Empty for anything not worn. |
| `tags` | string[] | no | Author-owned gameplay tags. |

**Schema `2` replaced `icon` with `frames`** (ADR-0050). An icon is the same
flipbook a decoration animates with — an ordered list of images played at a
fixed rate — and the still icon nearly every object has is that flipbook one
frame long. There is no reader for the old field: a `1` file's `icon` is
ignored, and this project ships no object content.

`resolveObject` / `previewObject` return a `ResolvedObject`
(`{ id, resolution, frames, frame, asset, durationMs, looping }`), so a panel
does not redo the frame arithmetic (`docs/wasm-api.md`).

An object with no `nameKey` and no `frames` is a **warning**, not an error: an
object is routinely written before its art and its text exist, and the editor
creates every key it names on save (ADR-0027). A frame that names *nothing*, on
the other hand, is an error — it is a row an author left half-filled.

What is deliberately absent: effects, prices, damage, durability. What drinking
a potion *does* is scenario and combat content; `kind` and `tags` are how
something is filed and found, not a behaviour table.

---

## Entity templates

`templateId` resolves against a **built-in registry** in
`crates/world/src/template.rs`:

| `templateId` | kind | behaviour | blocks movement |
|---|---|---|---|
| `player` | `player` | `playerControlled` | yes |
| `monster` | `monster` | `chasePlayer` | yes |

A template supplies the behaviour and the visual identity that the world file
deliberately does not carry.

**This is an MVP limitation, not the design.** The indirection is what matters:
templates can move into `content/templates/*.json` later without touching a
single world file, because worlds only ever reference an id.

---

## Validation

Run by `insulaire_world::validate_world`, used identically by the editor and the
runtime (ADR-0015). Each issue carries a stable `code`, a `severity`, a `path`
such as `entities[3].at`, and a message.

Two checks span more than one file and therefore have their own entry points:
`validate_project_links` resolves every link across the loaded worlds
(`link.unknownTargetWorld`, `link.targetOutOfBounds`, `link.targetImpassable`,
`link.targetOccupied`), and `validate_project` checks the manifest against what
is loaded. Both are
exposed across the boundary as `validateLinks()` and `loadProject()`.

**Errors** (content will not load):

| Code | Meaning |
|---|---|
| `world.missingId` | `id` is empty. |
| `world.unsupportedSchemaVersion` | Newer than this build understands. |
| `world.emptyMap` | `width` or `height` is `0`. |
| `world.emptyShape` | Every cell of the extent is absent, so the map has no hex. |
| `shape.outOfBounds` | A shape exception names a cell outside the extent. |
| `shape.duplicateCell` | A shape exception names the same cell twice. |
| `world.mapTooLarge` | A dimension exceeds 2048. |
| `world.unsupportedOrientation` | Not `"pointy"`. |
| `world.characterHeightTilesOutOfRange` | `characterHeightTiles` is not finite or outside `0.25..=8`. |
| `world.gridLineWidthOutOfRange` | `grid.lineWidth` is outside `1..=4`. |
| `world.gridColorInvalid` | `grid.color` is not a six-digit RGB colour. |
| `world.gridAlphaOutOfRange` | `grid.alpha` is not finite or outside `0..=1`. |
| `world.revealRadiusOutOfRange` | `reveal.radius` is above `6`. |
| `world.revealOpacityOutOfRange` | `reveal.opacity` is not finite or outside `0..=1`. |
| `world.revealNeighbourOpacityOutOfRange` | `reveal.neighbourOpacity` is not finite or outside `0..=1`. |
| `world.unknownTileSet` | `tileSetId` is not loaded. |
| `world.unknownDefaultTile` | `defaultTile` is not in the tile set. |
| `world.missingPlayer` / `world.multiplePlayers` | Not exactly one player entity. |
| `tile.outOfBounds` | A placed tile is outside the extent. |
| `tile.absentCell` | **Warning.** A cell is painted but the map has no hex there. Paint deliberately outlives a hole. |
| `tile.duplicatePosition` | Two tiles painted on one cell. |
| `tile.unknownReference` | A placed tile references an unknown tile id. |
| `tile.elevationOutOfRange` | A placed tile's `elevation` is outside `-128..=127`. |
| `tile.unknownSurfaceVariant` | *(warning)* A cell's `art.surface` names a variant its tile declares in neither its `surface` nor its `flat` list. |
| `tile.unknownElevationTile` | *(warning)* A cell's `art.elevationTile` names a tile the set does not define. |
| `tile.unknownElevationVariant` | *(warning)* A cell's `art.elevation` names a variant no drawing level declares. |
| `tile.elevationTileWithoutLadder` | *(warning)* A cell borrows a ladder from a tile that authors none, so it draws no faces. |
| `tileArt.invalidGeometry` | A tile set's `art` has a side of `0` or above `512` — `flatHeight` included — an `elevationHeight` no taller than a quarter of its `surfaceHeight`, or a zero `elevationStep`. |
| `tileArt.stepTallerThanFaces` | *(warning)* `elevationStep` exceeds the side faces, so stacked levels leave a gap. |
| `tile.missingVariantId` / `tile.duplicateVariantId` | A tile art variant has no id, or a list declares one twice. |
| `tile.tooManyVariants` | More than 16 variants in one `flat` list, one `surface` list or one level. |
| `tile.unusableAsset` | An image path is empty, absolute, a URL, or steps outside the content root. |
| `tile.emptyElevationLevel` | An authored elevation level declares no image, so a cell that tall draws a hole. |
| `tile.tooManyElevationLevels` | More than 32 explicit levels; taller cells are what a repeat rule is for. |
| `tile.unknownRepeatSource` | A repeat rule names a level the tile does not author. |
| `tile.emptyRepeatPattern` | A `pattern` rule names no level. |
| `tile.repeatWithoutLevels` | A repeat rule with no explicit level to repeat. |
| `entity.missingId` / `entity.duplicateId` | Ids must exist and be unique. |
| `entity.outOfBounds` | Entity placed outside the extent. |
| `entity.absentCell` | Entity placed where the map has no hex. |
| `entity.onImpassableTile` | Entity standing on `movementCost: 0`. |
| `entity.unknownTemplate` | `templateId` is not in the registry. |
| `entity.overlappingPlacement` | Two blocking entities on one hex. |
| `location.missingId` / `location.duplicateId` / `location.outOfBounds` / `location.absentCell` | As above, for locations. |
| `link.missingId` / `link.duplicateId` | Link ids must exist and be unique within the world. |
| `link.outOfBounds` | A link is outside the extent. |
| `link.absentCell` | A link sits where the map has no hex, so it can never be entered. |
| `link.absentTargetCell` | A link arrives where the target map has no hex. |
| `link.duplicatePosition` | Two links on one cell. |
| `link.onImpassableTile` | A link sits on `movementCost: 0`, so it can never be entered. |
| `link.missingTarget` | `targetWorld` is empty. |
| `link.unsupportedTrigger` | `trigger` is not `"enter"`. |
| `link.targetOutOfBounds` | `targetAt` is outside the target map. Reported for a self-link by `validateWorld`, otherwise by `validateLinks`. |
| `link.unknownTargetWorld` | `targetWorld` is not loaded. Reported by `validateLinks` only. |
| `link.targetImpassable` | `targetAt` is an impassable cell in the target map. Reported by `validateLinks` only. |
| `link.targetOccupied` | `targetAt` holds an authored non-player entity in the target map; the arriving player would share its hex. Reported by `validateLinks` only. |
| `project.missingId` / `project.unsupportedSchemaVersion` | Manifest header problems. |
| `project.noWorlds` / `project.duplicateWorld` | The manifest lists no worlds, or one twice. |
| `project.unloadedWorld` / `project.unloadedTileSet` | The manifest references content that is not loaded. |
| `project.duplicateZone` / `project.missingZoneId` | The manifest declares a zone twice, or one without an id. |
| `world.unknownZone` | A loaded world names a zone the project does not declare. Reported when the project is loaded. |
| `project.unknownStartWorld` | `startWorld` is not among the manifest's worlds. |
| `locale.missingLanguageId` / `locale.duplicateLanguage` | The manifest declares a language without an id, or one twice. |
| `locale.missingNamespace` / `locale.duplicateNamespace` / `locale.missingPath` | A locale file has no namespace id, repeats one within a language, or has no path. |
| `locale.unknownDefaultLanguage` | `locales.default` is not among the declared languages. |
| `locale.unloadedLanguage` | A declared language has no loaded locale file. Reported when the project is loaded. |
| `locale.missingKey` | Content references an empty text key, which names nothing. |
| `project.unloadedTitleScreen` | The manifest names a title screen that is not loaded. |
| `titleScreen.missingId` / `titleScreen.unsupportedSchemaVersion` | Title screen header problems. |
| `titleScreen.missingTitleKey` / `titleScreen.missingLabelKey` | A key field is empty. |
| `titleScreen.noNewGame` | No visible `newGame` button: the menu cannot start a game. |
| `titleScreen.duplicateAction` | The same action is offered twice. |
| `titleScreen.invalidAssetPath` | An asset path is absolute, a URL, or steps outside the content root. |
| `titleScreen.logoWidthOutOfRange` / `titleScreen.durationOutOfRange` / `titleScreen.gainOutOfRange` | A number is outside its range. |
| `project.unloadedSettings` | The manifest names a settings file that is not loaded. |
| `settings.missingId` / `settings.unsupportedSchemaVersion` | Settings header problems. |
| `settings.missingFieldId` / `settings.duplicateField` | A setting has no id, or two share one. |
| `settings.missingLabelKey` | A section, group, field or option has no label key. |
| `settings.noOptions` / `settings.duplicateOption` | A `select`/`multiSelect` declares no options, or the same value twice. |
| `settings.emptyRange` / `settings.invalidStep` | `min` above `max`, or a step that is not positive. |
| `settings.invalidDefault` / `settings.defaultOutOfRange` | The default is not a value the control accepts, or is outside the bounds. |
| `settings.unknownCondition` | A `showIf` points at a field nobody declares. |
| `settings.keyBindingScope` | A `keyBinding` is not session-scoped. |
| `project.unloadedCharacter` / `project.duplicateCharacter` | The manifest names a character that is not loaded, or lists one twice. |
| `character.missingId` / `character.unsupportedSchemaVersion` | Character header problems. |
| `character.missingParameterId` / `character.duplicateParameter` | A parameter has no id, or two share one. |
| `character.missingLabelKey` / `character.noOptions` / `character.duplicateOption` / `character.emptyRange` / `character.invalidStep` / `character.invalidDefault` / `character.defaultOutOfRange` | A parameter breaks a control rule. Same checks as the `settings.*` codes above, under this file's namespace. |
| `character.unsupportedControl` / `characterCreation.unsupportedControl` | A character value tries to use the settings-only `keyBinding` control. |
| `character.unknownCondition` | A parameter's `showIf` points at a parameter nobody declares. |
| `character.invalidResolution` | A canvas side is `0` or above `256`. |
| `character.missingLayerId` / `character.duplicateLayer` | A layer has no id, or two share one. |
| `character.missingVariantId` / `character.duplicateVariant` | A variant has no id, or a layer declares one twice. |
| `character.unknownConditionParameter` | A variant's `when` names something that is neither a declared parameter nor a pose key any animation sets. |
| `character.emptyRect` | A variant's box has zero width or height, so its sprite would not be drawn. |
| `character.missingAsset` | A variant names no image. |
| `character.invalidAssetPath` | An asset path is absolute, a URL, or steps outside the content root. |
| `character.unknownTintParameter` | A tint names a parameter that is not declared. |
| `character.missingTint` | A `fixed` tint carries no colour. |
| `character.unknownParent` | A layer hangs off a layer nobody declares. |
| `character.circularHierarchy` | A chain of parents comes back to where it started. |
| `character.unknownAnchor` | A `parentAnchor` names an attachment point the parent does not declare. |
| `character.missingAnchorId` / `character.duplicateAnchor` | An attachment point has no id, or a layer declares one twice. |
| `character.missingAnimationId` / `character.duplicateAnimation` | An animation has no id, or two share one. |
| `character.duplicateAnimationRole` | Two animations claim the same gameplay role, so selection would be ambiguous. |
| `character.invalidFrameCount` | An animation is `0` frames long, or longer than `240`. |
| `character.invalidFrameDuration` | An animation gives each frame no time at all. |
| `character.unknownTrackNode` | A track drives a layer this character does not declare. |
| `character.duplicateTrack` | One animation drives the same node twice. |
| `character.keyframeOutOfRange` | A keyframe sits past the animation's last frame. |
| `character.duplicateKeyframe` | A track writes the same frame twice. |
| `character.poseFrameOutOfRange` | A `poses` entry sits past the animation's last frame. |
| `character.duplicatePoseFrame` | An animation sets a pose twice at the same frame. |
| `character.unknownMirrorSource` | A `mirrorOf` names an animation nobody declares. |
| `character.chainedMirror` | A `mirrorOf` names an animation that is itself a mirror. |
| `project.unloadedDecoration` / `project.duplicateDecoration` | The manifest names a decoration that is not loaded, or lists one twice. |
| `decoration.missingId` / `decoration.unsupportedSchemaVersion` | Decoration header problems. |
| `decoration.invalidResolution` | A canvas side is `0` or above `256`. |
| `decoration.orderOutOfRange` | `order` is outside `-999..=999`. |
| `decoration.missingAnimationId` / `decoration.duplicateAnimation` | An appearance has no id, or two share one. |
| `decoration.emptyAnimation` | An appearance declares no frame, so it draws nothing. |
| `decoration.tooManyFrames` | An appearance declares more than 64 frames. |
| `decoration.invalidFrameDuration` | An appearance has several frames and a frame duration of `0`, so it would never advance. |
| `decoration.missingFrame` | A frame names no image. |
| `decoration.invalidAssetPath` | A frame's image path is absolute, a URL, or steps outside the content root. |
| `decoration.missingPlacementId` / `decoration.duplicatePlacementId` | A placed decoration has no id, or two share one — a scenario could not say which it means. |
| `decoration.missingReference` | A placed decoration names no definition. |
| `decoration.outOfBounds` / `decoration.absentCell` | A placed decoration is outside the extent, or on a cell the map does not have. |
| `decoration.offsetOutOfRange` | A placement's nudge is beyond `±256px` on an axis. |
| `decoration.unknownDefinition` | A map places a decoration nothing loaded. Reported when the **project** loads, like a link's `targetWorld`. |
| `project.unloadedObject` / `project.duplicateObject` | The manifest names an object that is not loaded, or lists one twice. |
| `object.missingId` / `object.unsupportedSchemaVersion` | Object header problems. |
| `object.invalidResolution` | An icon canvas side is `0` or above `256`. |
| `object.invalidStackSize` | `stackSize` is `0` or above `9999`. |
| `object.invalidAssetPath` | An icon frame path is absolute, a URL, or steps outside the content root. |
| `object.missingFrame` | An icon frame names no image. |
| `object.tooManyFrames` | An icon declares more than 64 frames. |
| `object.invalidFrameDuration` | An icon has several frames and a frame duration of `0`, so it would never advance. |
| `tileSet.empty` / `tileSet.paletteTooLarge` / `tile.duplicateId` / `tile.missingVisualId` | Tile set problems. |

**Warnings** (content loads):

| Code | Meaning |
|---|---|
| `world.noMonsters` | Nothing will chase the player. |
| `locale.missingTranslation` | A key the default language defines is missing from another language; its text is served instead. |
| `locale.orphanKey` | A language defines a key the default language does not. |
| `locale.emptyValue` | A translation is an empty string — the state a key is created in, and a gap the default language fills. |
| `locale.unknownKey` | Content references a key no language defines. It renders as itself until the language editor gives it text (`docs/adr/ADR-0027-authoring-creates-keys.md`). |
| `titleScreen.instantSplash` | A splash that lasts 0 ms and cannot be skipped will never be seen. |
| `settings.unusedOptions` | A control that does not choose from a list declares options. |
| `character.unusedOptions` | As above, for a character parameter. |
| `character.noLayers` / `character.emptyLayer` | A character draws nothing, or a layer has no variant. |
| `character.impossibleCondition` | A variant waits for a value its parameter's control can never hold, so it is never drawn. |
| `character.anchorWithoutParent` | A layer names an attachment point but hangs off nothing. Always a leftover. |
| `character.emptyTrack` | An animation declares a track with no keyframe, so it does nothing. |
| `character.emptyPose` | A `poses` entry sets no value, so that frame changes nothing. |
| `character.unreadPoseKey` | An animation sets a key no variant of this character waits on, so it changes nothing. |
| `character.mirrorWithPose` | A mirror sets a pose of its own, which is never read — the source's pose is what plays. |
| `character.mirrorWithTracks` | A mirror declares tracks of its own, which are never read. |
| `character.rectOutOfCanvas` | A variant reaches outside the declared canvas. Legal — a cape overhangs — and far more often a box left over from a smaller sprite. |
| `decoration.noAnimations` | A decoration declares no appearance, so it draws nothing. |
| `decoration.overflowsCell` | The drawing reaches past the hexagon it stands on. Legal — a big tree overhangs its cell — and worth knowing when it was not meant to. Only reported when the host supplies the cell's pixel grid. |
| `decoration.unknownDefaultAnimation` | `defaultAnimation` names an appearance nobody declares; the first one plays instead. |
| `object.missingNameKey` | An object names no key, so a player would see nothing in an inventory. The state an object is created in. |
| `object.noFrames` | An object has no icon yet. |
| `object.slotWithoutEquipment` | A `slot` on something that is not `equipment`: nothing will wear it. |
| `object.equipmentWithoutSlot` | Equipment that names no slot to be worn in. |

---

## File layout conventions

The editor writes worlds through
`apps/web/src/content/world-serializer.ts`, which produces one record per line:

```json
  "tiles": [
    { "at": [4, 1], "tile": "mountain" },
    { "at": [5, 1], "tile": "mountain" }
  ],
```

`content/characters/*.json` follow the same principle with the **variant** — and,
for an animation, the **keyframe** and the **pose entry** — as
the record: one per line, conditions, geometry and visual visible at once
(`apps/web/src/content/character-serializer.ts`).

`content/tilesets/*.json` are written by
`apps/web/src/content/tile-set-serializer.ts` with the **image** as the record:
one variant per line, so adding a variant is one added line rather than a
reshuffle. Its spec asserts the shipped set round-trips byte for byte.

`content/worlds/*.json` are written the same way, so an exported world diffs
cleanly against a hand-edited one. Tests assert that both shipped worlds and
`content/project.json` agree byte for byte with what the editor writes
(`world-serializer.spec.ts`).

Every world file carries all four record arrays — `tiles`, `entities`,
`locations`, `links` — even when empty.

Plain `JSON.stringify(world, null, 2)` is still valid input — the format
requirement is on writing, not reading.

### The tile-art bundle

`/content/tile-art.bundle` is **generated, never authored**. It carries every
allowed file under `assets/tiles/` in one response, so a map costs one request
instead of the hundred and eighty-four its sprites would
(`docs/adr/ADR-0040-tile-art-travels-as-one-bundle.md`).

```text
  0   magic        4 bytes   "ISLB"
  4   version      u32 LE    1
  8   headerBytes  u32 LE    length of the JSON header
  12  header       { "entries": [ { path, type, offset, length } ] }
  ..  payload      every file, concatenated, in header order
```

`offset` counts from the first byte of the payload. Entries are sorted by path,
so the same directory always packs to the same bytes.

Two things answer that URL and the runtime cannot tell them apart: the dev
server builds it in memory, rebuilding whenever a path, size or mtime under
`assets/tiles/` moves (`scripts/content-server.mjs`), and a build writes it into
`apps/web/public/content/` (`scripts/sync-content.mjs`). What is authored,
edited and versioned remains the individual PNGs; `.bundle` is not an allowed
content extension, so one cannot be uploaded, and it is absent from
`/api/content/tree`.

Reading it is optional. A caller that cannot — no file, a corrupt header, no
`createImageBitmap` — falls back to fetching each sprite on its own and draws
exactly the same pixels.

---

## Versioning and migration

`schemaVersion` is compared against the constants in
`crates/world/src/definition.rs` and `tileset.rs`. A file with a higher version
is rejected with a clear message rather than parsed optimistically.

An optional field with a `serde` default is backwards-compatible to read, but a
new authored capability still bumps the relevant schema constant so a file says
which vocabulary it was written against. Renaming or removing a field, or
changing the meaning of an existing one, likewise requires a bump and an
explicit migration.

`WORLD_SCHEMA_VERSION` is at **5**. Version 5 adds `reveal`, which says how far
relief may be seen through around the pointer (ADR-0047); every field of it is
defaulted, so a version-4 file loads unchanged. Version 4 added
`origin` and `shape`: a map is a set of hexes rather than a rectangle
(ADR-0046). Both default to what every earlier file meant — anchored at
`[0, 0]`, every cell present — so a version-3 file loads unchanged. Version 3
added the map-wide `grid` appearance used by both editor and Play; absent values
keep the former 1 px, black-at-25% renderer style. Version 2 added
`PlacedTile.art`, the per-cell art choice (ADR-0036). The shipped files are
written as `5`.

`TILE_SET_SCHEMA_VERSION` is at **2**. Version 2 added `art` — the set's pixel
grid and each tile's images (ADR-0035). Everything it added is optional with a
default, so a version-1 file still parses and draws its `fallbackColor`; the
shipped files are written as `2`.

`CHARACTER_SCHEMA_VERSION` is at **3**. Version 3 places a child layer's box
relative to the attachment point it hangs off (ADR-0034); version 2 was
ADR-0029's, where every box was absolute on the canvas; version 1 was
ADR-0028's, where a layer could be a coloured rectangle, ellipse or triangle on
a unit square of floats. Nothing reads 1 or 2 — before 1.0 a breaking change is
the answer rather than a migration (`CLAUDE.md`, "Versioning") — so a file
written against either must be rewritten, not converted. Rewriting a version-2
file means subtracting, from every child layer's `rect`, the canvas position of
the joint it hangs off.

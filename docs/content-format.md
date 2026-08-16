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
| Types | `crates/world/src/definition.rs`, `tileset.rs` | `apps/web/src/content/content-types.ts` |
| Validation | `crates/world/src/validation.rs` | *(none — see ADR-0015)* |
| Writing | `serde_json` | `apps/web/src/content/world-serializer.ts` |

---

## Coordinates

Positions are **odd-r offset** pairs written as a two-element array:

```json
"at": [4, 10]
```

meaning column 4, row 10. Rows run horizontally, `row` increases downwards, and
odd rows are shifted half a hex to the right. Full rationale in ADR-0014.

A `width x height` world addresses `col` in `0..width` and `row` in
`0..height`. Anything outside is a validation error.

---

## TileSetDefinition

The palette a world may paint with.

```json
{
  "id": "mvp_terrain",
  "schemaVersion": 1,
  "name": "MVP Terrain",
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
| `schemaVersion` | integer | yes | `1`. Higher versions are rejected. |
| `name` | string | no | Shown in the editor. |
| `tiles` | TileDefinition[] | yes | At least one, at most 256. |

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

**Why one `movementCost` and no `passable` flag.** Two fields can disagree; one
cannot. `0` is the impassable sentinel, and passability is derived from it.

**Why a colour in content.** `visualId` is the real reference; `fallbackColor`
lets the MVP ship without an asset pipeline and stays useful later as the colour
drawn while a texture loads. Rendering *logic* never appears in content.

---

## WorldDefinition

```json
{
  "id": "demo_world",
  "schemaVersion": 1,
  "name": "Demo Valley",
  "width": 20,
  "height": 20,
  "orientation": "pointy",
  "projection": "isometric",
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
  "metadata": {
    "author": "hex-engine",
    "description": "…",
    "updatedAt": "2026-08-16T00:00:00.000Z"
  }
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Stable id. Loading a world replaces any world with the same id. |
| `schemaVersion` | integer | yes | `1`. |
| `name` | string | no | Display name. |
| `width`, `height` | integer | yes | Columns and rows. `1..2048`. |
| `orientation` | `"pointy"` \| `"flat"` | no | Defaults to `"pointy"`. `"flat"` is reserved and currently rejected. |
| `projection` | `"topDown"` \| `"isometric"` | no | Defaults to `"topDown"`. How the renderer draws this world; see below. |
| `tileSetId` | string | yes | The `TileSetDefinition` this world paints with. |
| `defaultTile` | string | yes | Tile used for every cell not listed in `tiles`. |
| `tiles` | PlacedTile[] | no | Only the cells that differ from `defaultTile`. |
| `entities` | EntityDefinition[] | no | Placed entities. Exactly one player is required to play. |
| `locations` | LocationDefinition[] | no | Points of interest. |
| `metadata` | object | no | Free text; never read by the simulation. |

### Sparse storage

`tiles` lists **only** the cells that differ from `defaultTile`. A 20x20 demo
world with a lake and a ridge is 82 lines rather than 400, and painting one hex
changes one line of the diff. The runtime expands this into a dense buffer on
load; the editor re-sparsifies on export.

### Projection and elevation

`projection` is **presentation carried by content**. The simulation never reads
it and no rule may depend on it; it decides how the renderer draws the map, and
it travels to the UI on `WorldView.projection`
(`docs/adr/ADR-0016-isometric-projection.md`).

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

### EntityDefinition

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Stable id, unique within the world. |
| `templateId` | string | yes | `"player"` or `"monster"` (see below). |
| `at` | `[col, row]` | yes | Position. Must be in bounds and on a passable tile. |
| `tags` | string[] | no | Free-form tags, carried into the runtime. |
| `properties` | object | no | Opaque to MVP rules; carried through. |

### LocationDefinition

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Stable id, unique within the world. |
| `at` | `[col, row]` | yes | Position. Must be in bounds. |
| `name` | string | no | Display name. |
| `tags` | string[] | no | Free-form tags. |

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

Run by `hex_world::validate_world`, used identically by the editor and the
runtime (ADR-0015). Each issue carries a stable `code`, a `severity`, a `path`
such as `entities[3].at`, and a message.

**Errors** (content will not load):

| Code | Meaning |
|---|---|
| `world.missingId` | `id` is empty. |
| `world.unsupportedSchemaVersion` | Newer than this build understands. |
| `world.emptyMap` | `width` or `height` is `0`. |
| `world.mapTooLarge` | A dimension exceeds 2048. |
| `world.unsupportedOrientation` | Not `"pointy"`. |
| `world.unknownTileSet` | `tileSetId` is not loaded. |
| `world.unknownDefaultTile` | `defaultTile` is not in the tile set. |
| `world.missingPlayer` / `world.multiplePlayers` | Not exactly one player entity. |
| `tile.outOfBounds` | A placed tile is outside the map. |
| `tile.duplicatePosition` | Two tiles painted on one cell. |
| `tile.unknownReference` | A placed tile references an unknown tile id. |
| `tile.elevationOutOfRange` | A placed tile's `elevation` is outside `-128..=127`. |
| `entity.missingId` / `entity.duplicateId` | Ids must exist and be unique. |
| `entity.outOfBounds` | Entity placed outside the map. |
| `entity.onImpassableTile` | Entity standing on `movementCost: 0`. |
| `entity.unknownTemplate` | `templateId` is not in the registry. |
| `entity.overlappingPlacement` | Two blocking entities on one hex. |
| `location.missingId` / `location.duplicateId` / `location.outOfBounds` | As above, for locations. |
| `tileSet.empty` / `tileSet.paletteTooLarge` / `tile.duplicateId` / `tile.missingVisualId` | Tile set problems. |

**Warnings** (content loads):

| Code | Meaning |
|---|---|
| `world.noMonsters` | Nothing will chase the player. |

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

`content/worlds/demo_world.json` is written the same way, so an exported world
diffs cleanly against a hand-edited one. A test asserts the two agree byte for
byte (`world-serializer.spec.ts`).

Plain `JSON.stringify(world, null, 2)` is still valid input — the format
requirement is on writing, not reading.

---

## Versioning and migration

`schemaVersion` is compared against the constants in
`crates/world/src/definition.rs` and `tileset.rs`. A file with a higher version
is rejected with a clear message rather than parsed optimistically.

Adding an **optional** field is a backwards-compatible change and does not need
a version bump: every optional field has a `serde` default. Renaming or removing
a field, or changing the meaning of an existing one, requires bumping
`WORLD_SCHEMA_VERSION` and adding an explicit migration.

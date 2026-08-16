# Conceptual Data Model

Definitions describe *authored content*; state describes *a play session*. The
two are strictly separate (ADR-0003). The wire format for definitions is
specified in `docs/content-format.md`; the boundary DTOs in `docs/wasm-api.md`.

## WorldDefinition

An authored world contains at minimum:

- `id`
- `schemaVersion`
- `width`
- `height`
- `orientation`
- `projection` — presentation only; carried, never interpreted by the engine
- `tileSetId`
- `defaultTile`
- `tiles`
- `locations`
- `entities`
- `links` — cells that send the player to another map (ADR-0017)
- `metadata`
- *(planned)* `scenarioId`

The map is not derived from a seed.

Cells are stored **sparsely**: `tiles` lists only the cells that differ from
`defaultTile`. The runtime expands this once, at load, into a dense buffer.

## ProjectDefinition

A world knows its tile set and the maps its doors lead to, but nothing in a
world says which files make up a *game* or where a session starts. That is the
project manifest (`content/project.json`): `id`, `schemaVersion`, `startWorld`,
and the `tileSets` and `worlds` it ships, each as `{ id, path }`. A delivered
client build boots from it (ADR-0018); the editor regenerates it whenever the
set of maps changes.

## TileDefinition

A tile is a palette entry living in a `TileSetDefinition`, not a map cell:

- identity (`id`, `name`, `terrain`)
- sprite/tile source (`visual.visualId`, with `visual.fallbackColor`)
- tags
- movement cost — **`0` means impassable**
- gameplay properties
- *(planned)* render layer

Map cells (`PlacedTile`) carry a position, a reference to one of these ids, and
an `elevation` — relief the renderer draws in isometric mode and the rules
ignore (ADR-0016).

## EntityDefinition

A placed entity contains:

- hex position (`at`)
- template (`templateId`)
- tags
- persistent properties
- behaviour reference — *supplied by the template*
- asset reference — *supplied by the template*

Templates currently live in a built-in registry
(`crates/world/src/template.rs`) rather than in content files. The indirection
is what matters: worlds reference an id, so templates can become content later
without touching a single world file.

## ScenarioDefinition

*Not implemented in the MVP.* The scenario will contain acts, phases,
objectives, flags, timers, triggers, events and consequences (ADR-0005). Phases
5 and 6 of the tick pipeline are already reserved for it and are explicit no-ops
in `crates/simulation/src/tick.rs`.

References should use stable IDs rather than fragile array indices or positions.

## Runtime State

Definitions are immutable during a play session. The runtime maintains mutable
state:

```text
GameState                        crates/simulation/src/state.rs
├── tick                         u64, one per accepted action
├── worldId                      which authored world is being played
├── seed                         owned by the engine, never by JavaScript
├── grid          ── Arc ──────> WorldGrid   (immutable authored reference data)
├── links                        the current map's doors, copied from content
├── entities                     EntityStore: compact handles + positions
├── rngState                     serialisable PCG32
├── scenarioState?               (planned)
└── combatState?                 (planned)
```

The authored `WorldGrid` is shared behind an `Arc` rather than copied: it is
reference data, so a play session borrows it instead of owning a duplicate.

`worldId`, `grid` and `links` change together when the player walks through a
door: `GameState::enter_world` rebuilds the state from the target world and
carries `tick`, the RNG stream and the arrival position across. The player
entity is the one the target map authors, so every map stays independently
playable (ADR-0017).

### WorldGrid

The flattened runtime view of a world:

- `width`, `height`
- `palette: Vec<ResolvedTile>` — the tile set, flattened
- `cells: Vec<u8>` — one palette index per cell, row-major in offset
  coordinates
- `elevations: Vec<i8>` — one elevation per cell, in the same layout

`cells` and `elevations` are exactly the buffers handed to JavaScript as a
`Uint8Array` and an `Int8Array`, so the file coordinate, the buffer index and the
rendered position all agree.

### EntityStore

Runtime entities are addressed by a compact `EntityId` handle; the authored
string id travels alongside so saves, logs and the UI can refer to entities
stably.

## Editor state

The editor owns a third model, `WorldDocument`
(`apps/web/src/content/world-document.ts`), and it is neither of the above: a
world being *authored* has no tick, no RNG and no entity handles, and every
cell is freely mutable. It holds a dense `Uint8Array` of palette indices and a
dense `Int8Array` of elevations — the same layout the runtime and the renderer
use — plus the authored `projection`, and re-sparsifies on export.

The editor holds **one document per map**, not one document
(`ProjectStoreService`, `apps/web/src/app/services/project-store.service.ts`),
together with the manifest and the loaded tile sets. Map links require it: a
door names another map, so authoring one means having the others in hand, and
the whole set is what `validateLinks` judges. The store also owns which map is
open, whether anything is dirty, and the `localStorage` mirror — which only the
dev build writes (ADR-0018).

Editor state and runtime state never mix. The only things that cross between
them are a `WorldDefinition` and a `ProjectDefinition`: files.

## Why

This supports:
- multiple playthroughs using the same world
- compact saves
- editor-driven content
- automated validation
- future content migrations

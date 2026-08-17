# Angular ↔ Rust/WASM Boundary

The engine's whole public surface. Decided in ADR-0013.

```text
┌─────────────────────────────────────────── Angular ───────────────────────────────────────────┐
│  EditorPage / PlayPage        →  EngineService        →  /wasm/hex_engine.js (generated glue)  │
│  (UI, input, presentation)       (typed wrapper)                                               │
└────────────────────────────────────────────┬───────────────────────────────────────────────────┘
                                             │  JSON strings + one Uint8Array
┌────────────────────────────────────────────▼───────────────────────────────────────────────────┐
│  hex-wasm       thin #[wasm_bindgen] pass-through, no logic                                     │
│  hex-engine     JsonEngine (string contract)  →  Engine (facade)  →  ContentRegistry            │
│  hex-simulation GameState · tick pipeline · movement rules · monster AI · RNG                   │
│  hex-world      hex coordinates · content definitions · validation · packed grid                │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

TypeScript types for everything below: `apps/web/src/engine/engine.types.ts`.
Rust types: `crates/engine/src/dto.rs`.

---

## Loading the module

`wasm-pack build --target web` output is published as a **static asset** under
`apps/web/public/wasm/`, not bundled by Angular. `load-engine-module.ts` imports
it at runtime:

```ts
const specifier = '/wasm/hex_engine.js';
const module = await import(/* @vite-ignore */ specifier);
await module.default({ module_or_path: '/wasm/hex_engine_bg.wasm' });
const engine = new module.HexEngine();
```

Rebuilding the engine is `npm run wasm:build` plus a refresh — no Angular
rebuild. The cost is that generated typings are not used; `engine.types.ts`
states the contract by hand instead, which is also what this document specifies.

---

## Conventions

**Positions** cross as offset pairs `[col, row]` (ADR-0014).

**Structured payloads** cross as JSON strings. Payloads are a few hundred bytes,
so parse cost is irrelevant and the boundary stays inspectable from devtools.

**Bulk data** does not use JSON: `terrainBuffer` returns a `Uint8Array` and
`elevationBuffer` an `Int8Array`.

**Failures** throw a JSON string:

```json
{ "code": "invalidContent", "message": "…", "report": { "valid": false, "issues": [ … ] } }
```

| `code` | When |
|---|---|
| `parse` | Malformed JSON, or an unknown command shape. |
| `invalidContent` | Content parsed but failed validation. Carries `report`. |
| `unknownContent` | A referenced world or tile set id is not registered. |
| `noGame` | An operation needed a running game and there was none. |
| `setup` | A valid world could not be instantiated. |

`EngineService` converts these into typed `EngineError`s; the rest of the app
never sees a raw string.

**An illegal command is not a failure.** It returns a `CommandResult` with
`accepted: false` and a `rejection`, and the state is untouched.

---

## Methods

### `engineInfo(): EngineInfo`

Build identity of the running binary.

```json
{
  "name": "hex-engine",
  "version": "0.1.0",
  "targetArch": "wasm32",
  "pointerWidth": 32,
  "worldSchemaVersion": 1,
  "tileSetSchemaVersion": 1
}
```

`targetArch` comes from `std::env::consts::ARCH` inside the module, so
`"wasm32"` is the engine reporting its own compilation target. The application
shell displays it.

### `loadTileSet(json: string): LoadOutcome`

Parses, validates and registers a `TileSetDefinition`. Replaces any tile set
with the same id. Throws `parse` or `invalidContent`.

```json
{ "id": "mvp_terrain", "report": { "valid": true, "issues": [] } }
```

### `loadWorld(json: string): LoadOutcome`

Same, for a `WorldDefinition`, validated against its already-registered tile
set. Only registered on success; warnings do not block.

### `loadProject(json: string): LoadOutcome`

Registers the `ProjectDefinition` manifest — which content files make up the
game, its `startWorld` and its `zones`. Call it **after** the content it lists:
it is validated against what is actually in the registry, so a bundle missing a
file fails here rather than when a player walks through a door (ADR-0018).

This is also where every loaded world's `zone` is resolved against the zones the
project declares, since a world file alone cannot say whether its zone exists
(ADR-0021).

Errors: `parse`, `invalidContent` (`project.unloadedWorld`,
`project.unknownStartWorld`, `world.unknownZone`, …).

### `resetContent(): void`

Forgets every loaded tile set, world and project. Loading is otherwise additive
— a world stays registered under its id until something replaces it — so a host
re-loading a whole project calls this first, or content the author deleted keeps
satisfying the doors that point at it.

A running game is unaffected: it holds its own handle on the world it is
playing. Its map can no longer be re-fetched with `worldView` until the content
is loaded again, so reset only when you are about to.

### `validateLinks(): ValidationReport`

Resolves every map link across the loaded worlds. This is the check no single
world file can make: a link's `targetWorld` lives in another file, so
`loadWorld` and `validateWorld` deliberately accept a world whose doors do not
resolve yet (ADR-0017).

```json
{
  "valid": false,
  "issues": [
    {
      "code": "link.unknownTargetWorld",
      "severity": "error",
      "path": "demo_world.links[0].targetWorld",
      "message": "link `link_refuge_door` targets world `demo_refuge`, which is not loaded"
    }
  ]
}
```

Codes: `link.unknownTargetWorld`, `link.targetOutOfBounds`,
`link.targetImpassable`.

### `validateWorld(json: string): ValidationReport`

Validates **without registering**. This is the editor's pre-export check, and it
is the same validator `loadWorld` runs (ADR-0015).

```json
{
  "valid": false,
  "issues": [
    {
      "code": "entity.onImpassableTile",
      "severity": "error",
      "path": "entities[3].at",
      "message": "entity `monster_3` stands on an impassable tile at [5, 5]"
    }
  ]
}
```

### `contentSummary(): ContentSummary`

What the registry holds: tile set ids, world summaries, the entity templates
this build knows, and `project` — the loaded manifest as
`{ id, name, startWorld, worldIds }`, or `null` when none was loaded.

### `worldView(worldId: string): WorldView`

Everything the renderer needs about a world **except** the per-cell buffers.

```json
{
  "worldId": "demo_world",
  "name": "Demo Valley",
  "width": 20,
  "height": 20,
  "orientation": "pointy",
  "projection": "isometric",
  "tileSetId": "mvp_terrain",
  "palette": [
    { "index": 0, "id": "grass", "name": "Grass", "terrain": "grass",
      "movementCost": 1, "passable": true,
      "visualId": "terrain.grass", "fallbackColor": "#4a7c3f", "tags": ["open"] }
  ],
  "locations": [ { "id": "loc_camp", "name": "Camp", "at": [3, 11], "tags": ["start"] } ],
  "links": [
    { "id": "link_refuge_door", "name": "Refuge", "at": [3, 10],
      "targetWorld": "demo_refuge", "targetAt": [3, 4], "trigger": "enter", "tags": ["door"] }
  ],
  "cellCount": 400
}
```

Fetched **once per world**.

`projection` is `"topDown"` or `"isometric"`, republished from the authored
world. The engine transports it and never interprets it — it has no notion of
pixels (ADR-0014, ADR-0016).

### `terrainBuffer(worldId: string): Uint8Array`

One byte per cell — an index into `worldView().palette` — row-major in offset
coordinates, so cell `[col, row]` is at `row * width + col`.

This is one of the two bulk transfers in the API and the reason the renderer
never calls into WASM per tile. A 2048x2048 world costs one 4 MiB copy instead of
four million calls. Fetched **once per world**; terrain is authored and immutable
during play.

### `elevationBuffer(worldId: string): Int8Array`

One **signed** byte per cell, in exactly the same layout and of exactly the same
length as `terrainBuffer` — cell `[col, row]` is at `row * width + col`.

Presentation only: the renderer lifts cells by this much in isometric mode and
draws their side faces (ADR-0016). No rule reads it. Fetched **once per world**.

### `createGame(worldId: string, seed: number): GameSnapshot`

Starts a game on a registered world. `seed` is a `u32`; the engine owns it and
the RNG state from here on (ADR-0011). Replaces any game in progress.

### `snapshot(): GameSnapshot`

```json
{
  "worldId": "demo_world",
  "seed": 2026,
  "tick": 6,
  "player": {
    "id": 0, "contentId": "player_1", "templateId": "player", "kind": "player",
    "at": [3, 9], "axial": { "q": -1, "r": 9 },
    "visualId": "entity.player", "fallbackColor": "#f2c14e",
    "blocksMovement": true, "tags": ["hero"]
  },
  "entities": [ … ],
  "legalMoves": [[4, 9], [4, 8], [3, 8], [2, 9], [3, 10], [4, 10]],
  "rng": { "state": "0x8782b9c19c7598fd", "increment": "0xf17924fbda6a8abb", "draws": 12 }
}
```

Note what is **absent**: the map. A snapshot stays a few hundred bytes whatever
the world's size.

`legalMoves` is computed in Rust by running the same validation a real command
would, in canonical direction order. The UI highlights this list instead of
deriving adjacency itself.

RNG 64-bit values are hex strings because JSON numbers lose precision above
2^53.

### `dispatch(commandJson: string): CommandResult`

The only way the host changes the simulation.

```json
{ "type": "moveTo", "to": [3, 9] }
{ "type": "wait" }
```

Returns:

```json
{
  "accepted": true,
  "rejection": null,
  "events": [
    { "type": "entityMoved", "entity": 0, "contentId": "player_1", "from": [4, 10], "to": [3, 9] },
    { "type": "tickAdvanced", "tick": 1 },
    { "type": "entityMoved", "entity": 1, "contentId": "monster_1", "from": [17, 10], "to": [16, 10] }
  ],
  "state": { … GameSnapshot … }
}
```

On refusal:

```json
{
  "accepted": false,
  "rejection": { "code": "notAdjacent", "message": "hex [0, 0] is 10 steps away; only adjacent hexes can be entered" },
  "events": [ { "type": "actionRejected", "reason": { … } } ],
  "state": { … unchanged … }
}
```

Rejection codes: `noPlayer`, `sameHex`, `outOfBounds`, `notAdjacent`,
`impassable`, `occupied`.

Event types: `entityMoved`, `entityHeld` (a chaser had nowhere closer to go),
`tickAdvanced`, `actionRejected`, plus the map-link events below. Events are
ordered causally: the player's move, then the clock, then the monsters.

#### Changing map

When the player's move ends on a hex carrying a map link, the same
`CommandResult` reports the transition **and** comes back with `state.worldId`
already set to the new map (ADR-0017):

```json
{
  "accepted": true,
  "events": [
    { "type": "entityMoved", "entity": 0, "contentId": "player_1", "from": [4, 10], "to": [3, 10] },
    { "type": "linkTriggered", "link": "link_refuge_door", "toWorld": "demo_refuge", "to": [3, 4] },
    { "type": "tickAdvanced", "tick": 1 },
    { "type": "worldEntered", "fromWorld": "demo_world", "toWorld": "demo_refuge", "at": [3, 4] }
  ],
  "state": { "worldId": "demo_refuge", … }
}
```

A host that sees `state.worldId` change must fetch `worldView`,
`terrainBuffer` and `elevationBuffer` for the new map; the snapshot never
carries a map.

If the target cannot be reached — it was never loaded, or it fails setup — the
result carries `{ "type": "linkUnresolved", "link", "toWorld", "reason" }`
instead of `worldEntered`, and the session stays on its current map. Content
validation is meant to make that unreachable; it is an event rather than an
error so a partially loaded project degrades instead of ending the session.

### `endGame(): void` / `hasGame(): boolean`

Discards or reports the running game. Loaded content survives `endGame`.

---

## Tick contract

One accepted command == one tick. The pipeline is implemented literally in
`crates/simulation/src/tick.rs`, phase by phase, following ADR-0004:

1. validate
2. apply the player action
3. resolve immediate effects — a map link on the hex just entered is recorded
   here as a pending transition; nothing else in the MVP
4. advance world systems: `tick += 1`, then every chaser acts once
5. advance the scenario — *empty; ADR-0005 plugs in here*
6. resolve triggers and events — *empty*
7. emit observable changes

A pending transition is carried out by `Engine::dispatch` **after** phase 7, so
the pipeline's order is identical whether or not a link fired, and the tick
count of a move is the same either way.

**A rejected command changes nothing**: not the tick, not a position, not the
RNG. Asserted in `tick.rs`, `lib.rs`, `shipped_content.rs` and
`engine-integration.spec.ts`.

---

## Testing the boundary

The string contract lives in `hex_engine::JsonEngine`, not in the WASM crate, so
it is covered by plain `cargo test` — `crates/engine/src/json.rs` exercises
every method, both success and failure. `hex-wasm` adds no logic to test.

`apps/web/src/engine/engine-integration.spec.ts` then drives the **real**
`wasm-pack` output with the **real** files from `content/`, through the same
TypeScript types the application uses. It skips with a clear message when
`npm run wasm:build` has not been run.

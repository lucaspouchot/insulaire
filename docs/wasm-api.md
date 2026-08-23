# Angular ↔ Rust/WASM Boundary

The engine's whole public surface. Decided in ADR-0013.

```text
┌─────────────────────────────────────────── Angular ───────────────────────────────────────────┐
│  EditorPage / PlayPage        →  EngineService        →  /wasm/insulaire_engine.js (generated glue)  │
│  (UI, input, presentation)       (typed wrapper)                                               │
└────────────────────────────────────────────┬───────────────────────────────────────────────────┘
                                             │  JSON strings + one Uint8Array
┌────────────────────────────────────────────▼───────────────────────────────────────────────────┐
│  insulaire-wasm       thin #[wasm_bindgen] pass-through, no logic                                     │
│  insulaire-engine     JsonEngine (string contract)  →  Engine (facade)  →  ContentRegistry            │
│  insulaire-simulation GameState · tick pipeline · movement rules · monster AI · RNG                   │
│  insulaire-world      hex coordinates · content definitions · validation · packed grid                │
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
const specifier = '/wasm/insulaire_engine.js';
const module = await import(/* @vite-ignore */ specifier);
await module.default({ module_or_path: '/wasm/insulaire_engine_bg.wasm' });
const engine = new module.InsulaireEngine();
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
  "name": "insulaire-engine",
  "version": "0.1.0",
  "targetArch": "wasm32",
  "pointerWidth": 32,
  "worldSchemaVersion": 3,
  "tileSetSchemaVersion": 3
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

### `validateTileSet(json: string): ValidationReport`

Validates a `TileSetDefinition` **without** registering it — what the asset
editor calls before writing a file, so a set the editor accepts is a set the
runtime accepts (ADR-0015). Throws `parse` for malformed JSON; a set that parses
but is unusable produces an invalid report rather than an error.

### `previewTileRender(tileSetJson, tileId, projection, elevation, base, roll, choiceJson): ResolvedTileRender`

Resolves what to draw for one cell of a tile set **passed in** — content the
editor has not saved yet. `projection` is the world's own: `"isometric"`
resolves the surface and the cliff, and anything else — including a mode nobody
knows — resolves the flat image, which is what `ProjectionMode` defaults to
(`docs/adr/ADR-0037-a-flat-map-is-drawn-from-flat-art.md`). `base` is the height
the cell's side faces reach down to (the lower of its two front neighbours; `0`
for a tile standing on the ground), and `roll` is the cell's variant roll.

`choiceJson` is a `PlacedTileArt` — what the cell picked by hand — resolved
against the set that was passed in, so `elevationTile` may name any tile in it.
`"{}"` rolls everything, which is what a plain preview wants (ADR-0036).

```json
{
  "tileId": "cliff",
  "elevation": 3,
  "layers": [
    { "level": 1, "sourceLevel": 1, "asset": "assets/tiles/cliff_a.png", "drop": 1 },
    { "level": 2, "sourceLevel": 2, "asset": "assets/tiles/cliff_b.png", "drop": -1 }
  ]
}
```

Three steps of relief, on a set whose band spans two of them: one whole image
and half of the next, not three slices of the same picture. A set whose step
*is* its band answers three layers here, at drops `2`, `1` and `0`.

Lowest face first. `surface` is the cell's top face and is present at **every**
height — an elevation image holds the side faces alone — so a host draws the
layers and then the surface over them. `drop` counts `art.elevationStep`
authored pixels below the hexagon's lower shoulder line, and is **signed**: one
layer is one *band* of faces rather than one level of elevation
(`docs/content-format.md`), bands are stacked from the cell's foot so the lowest
ends on its silhouette, and the topmost may therefore start above the top face,
which is drawn over it. `level` is the band's index from the ground, which is
the ladder level it asks for. The whole image moves and nothing inside it is
transformed (`docs/adr/ADR-0035-tile-art-is-authored-and-resolved-by-level.md`,
`docs/adr/ADR-0041-a-cliff-is-stacked-in-bands.md`).

**One projection answers, never both.** A `topDown` request comes back with
`flat` alone — the untilted hexagon, drawn over the whole cell, with no
`surface` and no `layers`:

```json
{ "tileId": "cliff", "elevation": 3, "flat": "assets/tiles/cliff_flat_a.png" }
```

A tile that authors nothing for the projection in force resolves to
`{ "tileId": …, "elevation": … }` and nothing else, which is the host's signal
to fill `fallbackColor` (ADR-0037). Absent fields are omitted rather than sent
as `null`.

Which variant each layer takes follows the surface unless `choiceJson` says
otherwise, so a cell's cut matches the ground standing on it
(`docs/adr/ADR-0036-a-cell-may-choose-its-tile-art.md`).

Throws `parse`, or `unknownContent` when the set declares no such tile.

**The renderer does not call this per frame.** Resolution is mirrored in
`apps/web/src/renderer/tile-art.ts` for the draw loop, exactly as the hex maths
is mirrored (ADR-0014); this method exists for the editor's preview and to pin
the mirror against the real build in `engine-integration.spec.ts`.

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
(ADR-0021), and where the loaded **languages** are compared against the ones the
manifest declares (ADR-0023).

When `characterCreation` is present, load every character definition and then
`loadCharacterCreation` before this call. Missing registration reports
`project.unloadedCharacterCreation`.

Errors: `parse`, `invalidContent` (`project.unloadedWorld`,
`project.unknownStartWorld`, `world.unknownZone`, `locale.unloadedLanguage`, …).

### `loadLocale(language: string, namespace: string, json: string): LoadOutcome`

Registers one locale file — a nested object of strings — under a language and a
namespace. The namespace prefixes every key in the file, so `menu.json`
registered as `menu` answers `menu.title.buttons.newGame` (ADR-0023).

Files of one language are merged in load order, and a key defined twice is
refused rather than overwritten: which file wins must not depend on load order.
The returned `LoadOutcome.id` is `"<language>/<namespace>"`.

Load these **before** `loadProject`: a language the manifest declares without a
loaded file does not load.

Errors: `parse` (not an object of strings; a key defined twice).

### `locale(language: string): LocaleView`

One language's text, ready to look keys up in:

```json
{
  "language": "fr",
  "entries": { "menu.buttons.newGame": "Nouvelle partie", "menu.buttons.quit": "Quit" },
  "fallbacks": ["menu.buttons.quit"]
}
```

`entries` already has the project's default language filling every gap, and
`fallbacks` lists the keys that were filled that way. Hosts must not implement a
fallback of their own — this is the one place the rule lives, so every host
answers a key identically.

A key this language holds **empty** is a gap like a missing one: the default
language answers it, and it is listed in `fallbacks`. That is what makes a key
created before its text exists behave sensibly — the editor creates keys as
content names them (`docs/adr/ADR-0027-authoring-creates-keys.md`), and a key no
language gives text to renders as itself.

Errors: `unknownContent` when no file was loaded for that language.

### `validateLocales(): ValidationReport`

Compares the loaded languages against the manifest and against each other:
`locale.unloadedLanguage` (error), `locale.missingTranslation`,
`locale.orphanKey` and `locale.emptyValue` (warnings). This is the report an
editor's language screen is built from.

### `loadTitleScreen(json: string): LoadOutcome`

Registers the `TitleScreenDefinition` a client opens on (ADR-0024). Load it
**before** `loadProject`, which refuses a manifest whose title screen is not
loaded.

Validation covers the file's own shape — a visible `newGame` button, unique
actions, relative asset paths, numbers in range — and `loadProject` additionally
resolves every key it references against the loaded languages.

Errors: `parse`, `invalidContent` (`titleScreen.noNewGame`,
`titleScreen.invalidAssetPath`, …).

### `validateTitleScreen(json: string): ValidationReport`

The editor's pre-save check: the same validation as loading, **plus** the keys,
so one call answers both questions. Registers nothing.

Errors: `parse` when the JSON is malformed.

### `titleScreen(): TitleScreenDefinition`

The registered screen, with every default filled in — `layout`, `background.fit`,
`music.gain` and the rest — so a host never has to guess what an omitted field
means.

Errors: `unknownContent` when the project ships no title screen. That is a
legitimate state: a project without one starts on a map, and the client falls
back to a plain menu.

### `loadSettings(json: string): LoadOutcome`

Registers the `SettingsDefinition` the **game** declares (ADR-0025). Load it
before `loadProject`, which refuses a manifest whose settings file is not
loaded. The application's own settings are not content and never come through
here.

Errors: `parse`, `invalidContent` (`settings.duplicateField`,
`settings.invalidDefault`, …).

### `validateSettings(json: string): ValidationReport`

The editor's pre-save check: the declaration's own validation plus the keys it
references, resolved against the loaded languages. Registers nothing.

### `settings(): SettingsDefinition`

The registered declaration, defaults filled in.

Errors: `unknownContent` when the project declares none — a legitimate state.

### `resolveSettings(valuesJson: string): Record<string, unknown>`

Resolves a set of values against the declaration: defaults fill the gaps, a
value of the wrong type or an undeclared option falls back to the default, a
number outside its bounds is clamped, and an unknown key is dropped.

This is the **one** rule for what a value really is; the settings screen calls it
so that what a player sees and what `createGame` receives cannot disagree.

Errors: `parse` when the values are not a JSON object.

### `loadCharacter(json: string): LoadOutcome`

Registers a `CharacterDefinition` — how a kind of character is drawn, and what
may be chosen about one (ADR-0028). Load it before `loadProject`, which refuses
a manifest naming a character that is not loaded.

Errors: `parse`, `invalidContent` (`character.missingAsset`,
`character.unknownTintParameter`, `character.circularHierarchy`,
`character.unknownTrackNode`, …).

### `validateCharacter(json: string): ValidationReport`

The editor's pre-save check: the definition's own validation plus the keys it
references, resolved against the loaded languages. Registers nothing.

### `character(id: string): CharacterDefinition`

A registered definition, defaults filled in.

Errors: `unknownContent` when no definition has that id.

### `characterIds(): string[]`

Ids of every registered definition, sorted.

### `loadCharacterCreation(json: string): LoadOutcome`

Registers the project's generic `CharacterCreationDefinition` (ADR-0042).
Load character definitions first: a binding to `{ kind: "character" }`, a
binding to a parameter and preview overrides are validated against them.

Errors: `parse`, `invalidContent` (`characterCreation.unknownCharacter`,
`characterCreation.unknownParameter`, `characterCreation.forwardCondition`, …).

### `validateCharacterCreation(json: string): ValidationReport`

The editor's side-effect-free pre-save check: the same cross-character
validation as loading, plus localised keys against the languages already
loaded.

### `characterCreation(): CharacterCreationDefinition`

The registered declaration, defaults filled in. Errors with `unknownContent`
when the project declares none.

### `resolveCharacterCreation(choicesJson, characteristicsJson): CharacterCreationResult`

Resolves defaults, backwards `showIf` conditions and generic bindings into:

```json
{
  "character": "human_player",
  "choices": { "lineage": "elf", "hairStyle": "long" },
  "parameters": { "lineage": "elf", "hairStyle": "long" },
  "characteristics": { "name": "Neris", "mana": null }
}
```

No id receives special treatment. A hidden choice contributes nothing.

### `previewCharacterCreation(creationJson, choicesJson, characteristicsJson): CharacterCreationResult`

The same resolution for the in-hand declaration the editor is changing. It
does not register the declaration and does not require it to pass validation.

### `resolveCharacter(id, valuesJson, animation?, timeMs): ResolvedCharacter`

```ts
resolveCharacter(
  id: string,
  valuesJson: string,
  animation: string | undefined,
  timeMs: number,
): ResolvedCharacter
```

Resolves a **registered** definition against a customisation, at a moment of an
animation, producing the flat ordered list of sprites described in
`docs/content-format.md`: a canvas resolution and, per layer, a whole-pixel box,
an asset path and a resolved tint. The boxes are **absolute** whatever the file
measured them from, and the list is in **draw order**, back to front, with any
`order` a variant declared already applied — a host blits it as it stands
(`docs/adr/ADR-0034-layer-boxes-are-anchor-relative.md`). Each layer also
carries the `origin` its authored box was measured from, which an editor needs
and a renderer ignores. Values go through the same rule as
`resolveSettings`, and every tint is resolved here — a host blits what this
returned and decides nothing about appearance.

`animation` is an animation id; `timeMs` counts from the moment it started, and
the engine wraps a looping animation and holds a finished one on its last frame
(ADR-0031). The animation's offset is **already in each layer's `rect`**, so a
renderer needs no animation code at all; the payload also carries the `offset`
that was applied and a `pose` saying which frame it is.
`pose.durationMs` is one complete pass (the source's timing for a mirror), so a
host can return a transient movement animation to idle without duplicating the
timing calculation.

An animation may also set **pose values**, which join the customisation while it
plays and are what a variant's `when` selects on, so `layers[].variant` and
`layers[].asset` can differ frame to frame
(`docs/adr/ADR-0033-animations-set-pose-values.md`). The pose in force is
reported on `pose.values`; it is deliberately **not** merged into `values`,
which stay the customisation as given. A **mirrored** animation (`mirrorOf`)
returns its source's layers unchanged with `mirrored: true`, which asks the host
to draw the whole canvas flipped — the one thing a renderer has to act on.

`undefined` is the rest pose, and **so is an animation id the definition does
not declare** — that is not an error, because an editor previewing a definition
mid-edit may still be asking for one it has just deleted.

Errors: `parse`, `unknownContent`.

### `resolveCharacterRole(id, valuesJson, role, timeMs): ResolvedCharacter`

```ts
resolveCharacterRole(
  id: string,
  valuesJson: string,
  role: 'idle' | 'moveLeft' | 'moveRight' |
    'moveEast' | 'moveNorthEast' | 'moveNorthWest' |
    'moveWest' | 'moveSouthWest' | 'moveSouthEast',
  timeMs: number,
): ResolvedCharacter
```

The gameplay-facing form of character resolution (ADR-0043). It selects the
animation that declared `role`; an exact hex-direction role falls back to
`moveRight` on the eastern side and `moveLeft` on the western side. An
unassigned role is the rest pose. The returned payload and all customisation,
pose, mirror and timing rules are otherwise exactly those of
`resolveCharacter`.

Errors: `parse` for malformed values or an unknown role, `unknownContent` for
an unknown character id.

### `previewCharacter(characterJson, valuesJson, animation?, timeMs): ResolvedCharacter`

```ts
previewCharacter(
  characterJson: string,
  valuesJson: string,
  animation: string | undefined,
  timeMs: number,
): ResolvedCharacter
```

The same resolution for a definition **passed in** rather than registered: what
the editor previews content it is still writing with. Resolution is total, so an
incomplete definition previews as whatever it currently is instead of failing.

Errors: `parse` when either JSON argument is not JSON.

### `resetContent(): void`

Forgets every loaded tile set, world, locale, title screen, settings declaration,
character definition, character-creation declaration and project. Loading is otherwise additive
— a world stays registered under its id until something replaces it — so a host
re-loading a whole project calls this first, or content the author deleted keeps
satisfying the doors that point at it.

A running game is unaffected: it holds its own handle on the world it is
playing. Its map can no longer be re-fetched with `worldView` until the content
is loaded again, so reset only when you are about to.

### `resetLocales(): void`

Forgets every loaded language, keeping worlds, tile sets, title screen, settings
and project. Merging is additive and refuses a key twice, so a host that has
*edited* a locale file cannot simply load it again; this is the narrow door for
that, without the collateral damage of `resetContent`.

The language editor calls it after writing its files, then re-registers them with
`loadLocale` (`docs/adr/ADR-0027-authoring-creates-keys.md`).

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

Validates **without registering**. This is the editor's pre-save check, and it
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
this build knows, the ids of the loaded character definitions,
`characterCreation` (its loaded id or `null`), and `project` — the loaded manifest as
`{ id, name, startWorld, worldIds, languages }`, or `null` when none was loaded.
Each language is `{ id, name, isDefault }`, in author order: what a language
picker is built from.

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
  "characterHeightTiles": 2,
  "grid": { "lineWidth": 3, "color": "#336699", "alpha": 0.6 },
  "tileSetId": "mvp_terrain",
  "tileArt": { "width": 64, "surfaceHeight": 40, "elevationHeight": 26, "elevationStep": 8 },
  "palette": [
    { "index": 0, "id": "grass", "name": "Grass", "terrain": "grass",
      "movementCost": 1, "passable": true,
      "visualId": "terrain.grass", "fallbackColor": "#4a7c3f", "tags": ["open"],
      "art": {} }
  ],
  "locations": [ { "id": "loc_camp", "name": "Camp", "at": [3, 11], "tags": ["start"] } ],
  "links": [
    { "id": "link_refuge_door", "name": "Refuge", "at": [3, 10],
      "targetWorld": "demo_refuge", "targetAt": [3, 4], "trigger": "enter", "tags": ["door"] }
  ],
  "artChoices": [ { "cell": 47, "surface": 5, "elevationTile": 4 } ],
  "cellCount": 400
}
```

Fetched **once per world**.

`projection` is `"topDown"` or `"isometric"`, republished from the authored
world. The engine transports it and never interprets it — it has no notion of
pixels (ADR-0014, ADR-0016).

`characterHeightTiles` is likewise transported presentation: the projected
tile-face heights occupied by a 128-pixel character canvas, defaulting to `2`.
The renderer combines it with the hex layout and projection; no game rule reads
it (`docs/adr/ADR-0044-map-entity-presentation.md`).

`grid` is the authored appearance used whenever the host's grid toggle is on:
`lineWidth` in zoom-independent screen pixels, six-digit RGB `color`, and
`alpha` from `0` to `1`. Like the projection and character scale, the engine
only republishes it; editor and Play hand the same values to the shared canvas
renderer.

`tileArt` is the tile set's authored pixel grid — `width`, `flatHeight`,
`surfaceHeight`, `elevationHeight`, `elevationStep` — transported the same way
and for the same reason. The renderer derives its tilt and its per-level lift
from it, so a tile drawn from images and a tile filled with `fallbackColor`
agree about the shape of a hexagon (ADR-0035).

Each palette entry carries its `art`: the images the tile is drawn from in
either projection (`flat`, `surface`, `elevation`), empty for a tile that has
none. It rides on the palette rather than travelling separately because the
renderer already indexes the palette once per cell, and that is the whole
per-cell budget.

`artChoices` is the cells that chose their picture instead of rolling it, sorted
by `cell` and **omitted entirely** when none did — which is the normal case.
Each entry is `{ cell, surface?, elevationTile?, elevation? }`: a row-major cell
index into the packed buffers, then the choices, already resolved from the ids
the map file carries to indices into `palette` and into the variant lists.
`surface` is one index for both projections — it picks out of the tile's
`surface` list in an isometric world and out of its `flat` list in a top-down
one, wrapping when the two are different lengths (ADR-0037). A
choice whose id resolved to nothing is simply absent, and that cell rolls the
field as it always would; `validateWorld` reports the dangling reference
(ADR-0036). It travels as a sparse list rather than as three more packed buffers
because choosing is an authored exception.

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

### `createGame(worldId: string, seed: number, settingsJson: string): GameSnapshot`

Starts a game on a registered world. `seed` is a `u32`; the engine owns it and
the RNG state from here on (ADR-0011). Replaces any game in progress.

`settingsJson` is the **game's** settings as a JSON object, resolved against the
loaded declaration on the way in (ADR-0025). Pass `"{}"` when a project declares
none. The resolved values come back on every `GameSnapshot` as `settings`, which
is where a scenario will read them.

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

The browser presents every `entityMoved` — player and monsters alike — as a
linear glide from `from` to `to`. The returned `state` already holds `to` and
remains authoritative throughout; interpolation is render state and never a
second simulation snapshot (ADR-0044).

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

The string contract lives in `insulaire_engine::JsonEngine`, not in the WASM crate, so
it is covered by plain `cargo test` — `crates/engine/src/json.rs` exercises
every method, both success and failure. `insulaire-wasm` adds no logic to test.

`apps/web/src/engine/engine-integration.spec.ts` then drives the **real**
`wasm-pack` output with the **real** files from `content/`, through the same
TypeScript types the application uses. It skips with a clear message when
`npm run wasm:build` has not been run.

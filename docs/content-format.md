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
  "zone": "valley",
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
| `schemaVersion` | integer | yes | `1`. |
| `name` | string | no | Display name. |
| `zone` | string | no | Id of the `ZoneDefinition` this map belongs to. Absent means the project's default zone — never *no* zone; see below. |
| `width`, `height` | integer | yes | Columns and rows. `1..2048`. |
| `orientation` | `"pointy"` \| `"flat"` | no | Defaults to `"pointy"`. `"flat"` is reserved and currently rejected. |
| `projection` | `"topDown"` \| `"isometric"` | no | Defaults to `"topDown"`. How the renderer draws this world; see below. |
| `tileSetId` | string | yes | The `TileSetDefinition` this world paints with. |
| `defaultTile` | string | yes | Tile used for every cell not listed in `tiles`. |
| `tiles` | PlacedTile[] | no | Only the cells that differ from `defaultTile`. |
| `entities` | EntityDefinition[] | no | Placed entities. Exactly one player is required to play. |
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
  "schemaVersion": 1,
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
| `schemaVersion` | integer | yes | `1`. |
| `sections[].id` / `groups[].id` / `fields[].id` | string | yes | Stable ids. A **field** id is the key its value is stored under, and must be unique across the whole file. |
| `*.labelKey`, `fields[].helpKey` | string | `labelKey` | Keys, not text. |
| `fields[].control` | `toggle` \| `checkbox` \| `select` \| `multiSelect` \| `slider` \| `number` \| `text` \| `color` | yes | How it is presented, and therefore what it accepts. |
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

---

## CharacterDefinition

`content/characters/*.json` describes **how a kind of character is drawn, and
what may be chosen about one** (ADR-0028). The player's character is one of
them; an NPC, a monster or a boss is another, and nothing in the format is
specific to any of those.

A character is **composed of sprites** on a pixel canvas it declares
(ADR-0029). There is no procedural drawing vocabulary: a layer names an image.

```json
{
  "id": "human_player",
  "schemaVersion": 2,
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
| `schemaVersion` | integer | yes | `2` — the sprite format (ADR-0029). `1` was ADR-0028's primitives on a unit square and is gone. |
| `name` | string | no | Shown in the editor. Not player-facing, so not a key. |
| `category` | `player` \| `npc` \| `enemy` \| `monster` \| `other` | no | Filing only. **Never read by the resolver or the renderer.** Default `other`. |
| `resolution` | `{ width, height }` | no | The pixel canvas the sprites are authored on, `1..=256` a side. Default `64 × 128`. |
| `parameters[]` | `ControlDefinition[]` | no | The choices it offers. A definition may offer none. |
| `layers[]` | see below | no | The pieces it is drawn from, **back to front**. |

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
| `layers[].variants[]` | see below | no | The appearances it can take, **most specific first**. |
| `variants[].id` | string | yes | Stable id, unique within its layer. |
| `variants[].when` | `{ parameterId: value }` | no | Values this variant requires. Absent means "always". |
| `variants[].rect` | `[x, y, width, height]` | no | Where the sprite goes on the canvas, in **whole pixels**. `x`/`y` may be negative. |
| `variants[].sprite` | `{ asset, tint? }` | yes | The image it draws. |

**The first variant whose conditions hold is the one drawn**, so author order is
priority. A layer with no matching variant draws nothing, which is how an
optional piece — a cape, a helmet — is authored.

Every entry of `when` must match. A parameter holding a **list** matches a
scalar it *contains*, so `{ "equipment": "helmet" }` asks whether a helmet was
chosen among several.

`rect` is the sprite's box on the canvas. It should be the image's own pixel
size — any other size stretches it — and the editor fills it in from the image
when one is picked. A box reaching outside the canvas is legal (a cape
overhangs) and reported as a warning.

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
      "asset": "assets/characters/hair_front.png", "tint": "#8b5a2b" }
  ]
}
```

`tint` is **an empty string** when the sprite is drawn as authored — not `null`,
not a colour.

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
| `link.missingId` / `link.duplicateId` | Link ids must exist and be unique within the world. |
| `link.outOfBounds` | A link is outside the map. |
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
| `project.unloadedCharacter` / `project.duplicateCharacter` | The manifest names a character that is not loaded, or lists one twice. |
| `character.missingId` / `character.unsupportedSchemaVersion` | Character header problems. |
| `character.missingParameterId` / `character.duplicateParameter` | A parameter has no id, or two share one. |
| `character.missingLabelKey` / `character.noOptions` / `character.duplicateOption` / `character.emptyRange` / `character.invalidStep` / `character.invalidDefault` / `character.defaultOutOfRange` | A parameter breaks a control rule. Same checks as the `settings.*` codes above, under this file's namespace. |
| `character.unknownCondition` | A parameter's `showIf` points at a parameter nobody declares. |
| `character.invalidResolution` | A canvas side is `0` or above `256`. |
| `character.missingLayerId` / `character.duplicateLayer` | A layer has no id, or two share one. |
| `character.missingVariantId` / `character.duplicateVariant` | A variant has no id, or a layer declares one twice. |
| `character.unknownConditionParameter` | A variant's `when` names a parameter that is not declared. |
| `character.emptyRect` | A variant's box has zero width or height, so its sprite would not be drawn. |
| `character.missingAsset` | A variant names no image. |
| `character.invalidAssetPath` | An asset path is absolute, a URL, or steps outside the content root. |
| `character.unknownTintParameter` | A tint names a parameter that is not declared. |
| `character.missingTint` | A `fixed` tint carries no colour. |
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
| `character.rectOutOfCanvas` | A variant reaches outside the declared canvas. Legal — a cape overhangs — and far more often a box left over from a smaller sprite. |

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

`content/characters/*.json` follow the same principle with the **variant** as
the record: one per line, conditions, geometry and visual visible at once
(`apps/web/src/content/character-serializer.ts`).

`content/worlds/*.json` are written the same way, so an exported world diffs
cleanly against a hand-edited one. Tests assert that both shipped worlds and
`content/project.json` agree byte for byte with what the editor writes
(`world-serializer.spec.ts`).

Every world file carries all four record arrays — `tiles`, `entities`,
`locations`, `links` — even when empty.

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

`CHARACTER_SCHEMA_VERSION` is at **2**. Version 1 was ADR-0028's format, where a
layer could be a coloured rectangle, ellipse or triangle placed on a unit square
of floats; ADR-0029 replaced it with one sprite per layer on a declared pixel
canvas. Nothing reads version 1 — before 1.0 a breaking change is the answer
rather than a migration (`CLAUDE.md`, "Versioning") — so a file written against
it must be rewritten, not converted.

# Insulaire

A browser-based turn-based game engine with an **authored** hexagonal world, an
Angular UI/editor, and a Rust/WebAssembly simulation.

This repository currently contains the **MVP vertical slice**: enough of the
stack to prove the architecture works end to end, and nothing more.

```text
  Editor  ──►  WorldDefinition (JSON)  ──►  Rust/WASM  ──►  Play
   paint            save / import            validate       click a hex
   place            content/worlds/          simulate       watch the tick
```

---

## What works today

- Load an authored hex world from a JSON file.
- Render it to a Canvas with pan, zoom, hover, selection and viewport culling.
- Paint terrain, place a player and monsters, validate, save to disk and import.
- Author a **project of several maps** and link them: a door on a hex sends the
  player to another map, and the engine follows it during play.
- Start a playable test game **from the maps the editor is holding**.
- Click an adjacent hex: the engine validates it, moves the player, advances
  the tick by one, moves every monster one step towards the player, and returns
  what changed.
- An invalid move changes nothing — no movement, no tick, no randomness.
- Live display of the tick, every entity position, the engine's RNG state and
  the event stream coming out of Rust.
- Open on an **authored title screen** — background, music, splash and menu, all
  content — with a settings screen that mixes the application's own settings and
  whatever settings the game declares.
- Author those game settings in an editor, and see the player's screen build
  itself as you type.
- Read every displayed string from **language files**: the application ships
  English and French, and a project adds its own.
- Author a game in **its own directory**, outside this repository, with the
  editor uploading images and music straight into it.
- Produce a **client delivery** with `just deliver`: the game without the
  editor, as a desktop executable for Windows, macOS and Linux.

Deliberately **not** implemented yet: scenarios, combat, deckbuilding,
pathfinding, procedural generation, **saving and loading** (the title screen's
*Continue* is disabled until it exists, ADR-0010), an asset pipeline, a backend.

---

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| **Node.js** | ≥ 20.19, or ≥ 22.12 | `node --version`. Angular 21 requires this. |
| **Rust** | ≥ 1.82 (stable) | Install from <https://rustup.rs>. |
| **wasm32 target** | — | `rustup target add wasm32-unknown-unknown` |
| **GTK/WebKit dev packages** | — | Linux only, and only to build the desktop shell — see *Delivering the game*. |
| **MSVC C++ build tools, WebView2** | — | Windows only, same. WebView2 already ships with Windows 11 and current Windows 10. |

`wasm-pack` is **not** a manual install: it comes in as a dev dependency of this
repository, so `npm install` provides it.

If you have never used Rust/WASM tooling before, that is the whole story — the
three commands in the next section are all you need.

---

## Quick start

```bash
npm install          # JS dependencies + wasm-pack
npm run wasm:build   # compile the Rust engine to WebAssembly (~15 s first time)
npm run dev          # start Angular on http://localhost:4200
```

Open <http://localhost:4200>. You land on the **title screen** the content
declares; the top bar's **Editor** link opens the map editor on
`content/worlds/demo_world.json`.

The splash belongs to the *launch*, not to the route: it plays once per page
load, so coming back to the title screen from a game shows the menu directly.

Two screens take the whole window and drop the bar, because they are the
player's and not the developer's: the title screen and **Settings**. Settings
carries its own **Back**, which returns wherever it was opened from. And while a
game is running, **Title** asks before it navigates — arriving there ends the
session, and saving does not exist yet (ADR-0010). Going to the settings or the
editor does not: the engine holds the game, so coming back to **Play** resumes
it.

The header shows the open project's name on the left and, on the right, a badge
reading **Insulaire engine** whose tooltip is what the engine actually is:

```text
Running as WebAssembly · wasm32 · 32-bit · v0.1.0
```

That line is read out of the running WebAssembly module (`engineInfo()`
reports `std::env::consts::ARCH` from inside the binary), so it is the engine
identifying itself, not a label.

> If the badge says **Engine failed**, you skipped `npm run wasm:build`.

---

## Walkthrough

### Edit a world

The screen is the tools on the left, the canvas in the middle, and the active
tool's content on the right — the terrain palette under **Paint**, the project
browser under **Map**, nothing at all for the tools that need neither. Project
actions (validate, save, import) sit in the toolbar on top.

The **Map** tool is where a project is organised: add a map, pick one to open,
rename it. Every map belongs to a **zone** — a group of maps declared by
`project.json` and picked from a list, never typed. Zones are what a tick will
advance together, so a hunter two maps away keeps moving (ADR-0021; the
zone-wide tick is not implemented yet). Add one under *Zones*, put maps in it
from *Map settings* or when creating them; the picker filters on it and shows
five maps at a time, so a project of forty stays navigable.

1. Open **Editor**.
2. Pick a terrain in the palette (movement cost `0` means impassable).
3. Click or **drag** on the map to paint. Right-drag or middle-drag pans, the
   wheel zooms, `Fit` re-frames.
4. Switch the tool to **Player** or **Monster** and click a hex to place one. A
   world has exactly one player; placing a new one moves it.
5. **Erase** removes whatever entity, door or location stands on a hex.
6. Press **Validate**. The report comes from Rust — the same validator the
   runtime runs at load time — and points at the exact field, e.g.
   `entities[3].at · entity 'monster_3' stands on an impassable tile at [5, 5]`.
7. **Save map** writes the open map into the content directory, as
   `worlds/<id>.json`, through the authoring server `npm run dev` starts
   (ADR-0022). **Save project** does the same for every map. Both validate
   first, and **nothing is written when the report is not clean**: the files on
   disk are what the runtime boots on. **Import JSON** still loads a world file
   from anywhere on disk.

   A save writes a *difference*, not a dump. Only the maps that actually changed
   are rewritten — the timestamp alone does not count as a change, so untouched
   files stay untouched and the diff shows what you did. `project.json` follows
   when the manifest no longer describes the project (a map added, renamed,
   removed, or moved between zones), and the file of a map you removed — or the
   old file of one you renamed — is deleted. The message says which of those
   happened.

Without an authoring server — a static build of the editor — the toolbar says
*read-only* and both buttons are disabled.

Edits are mirrored into `localStorage`, so a refresh does not lose work.
**Reload content/** throws that away and re-reads the files from `content/`,
discarding anything not saved.

### Link two maps

1. With the **Map** tool, open the map to leave from.
2. Switch the tool to **Door** and click a passable hex.
3. In **Doors**, choose the map it leads to and the arrival `col, row`.
4. Press **Validate doors**. A door's target lives in another file, so this is a
   whole-project check in Rust — it reports `link.unknownTargetWorld`,
   `link.targetOutOfBounds` or `link.targetImpassable`.

In Play mode, walking onto the door changes map in the same tick, and the event
log shows `linkTriggered` then `worldEntered`. The demo ships two maps:
`demo_world` has a door at `[3, 10]`, one step from the player start, leading
into `demo_refuge` — whose own door leads back out.

### Other editors

`/editor` is a shell with one tab per module (ADR-0019). **Maps**, **Title
screen**, **Settings**, **Languages** and **Resources** are implemented;
**Scenario** is registered and routes to a placeholder describing what it will
own. Adding one is an entry in `editor-modules.ts` plus a component.

**Resources** is where everything the game is *drawn from* is authored, one
category per kind (ADR-0039). **Tiles** and **Characters** open today; objects,
decorations and effects are listed and open a placeholder. Every category wears
the same frame: the category rail on the left with that category's own list
under it, the scene in the middle, the definition on the right, and a **divider
you drag** between the two — a timeline wants a wide inspector and a figure
wants a wide scene. They share one set of pixel tools — pencil, eraser,
eyedropper, an opacity — and both paint **on the thing itself**: a character on
the composed figure, a tile on its hexagon. Zoom, *Fit* and the pixel grid sit
in the file bar, above whichever surface is open, so they are always in the same
place.

**Title screen** edits `menu/title-screen.json`: background, logo, splash,
music, theme, and the buttons with their label keys. Images and music are
uploaded straight into the content directory, and the preview on the right is
the real title screen component, so what you see is what a player gets.

**Settings** edits `settings.json`: the settings the *game* offers — sections
become tabs, groups become panels, fields become controls (ADR-0025). Pick a
control kind and the form offers exactly what that kind accepts: options for a
`select`, `min`/`max`/`step` for a slider, a `showIf` naming one other field.
The preview on the right is the player's screen, rendered with the same
component — and moving a control there is how a field's **default** is set.
`scope` decides when a player may change a setting: `session` at any time,
`newGame` only outside a game.

The application's own settings — volumes, interface scale, language, window
size, seed — are *not* editable there, because they are not content: the
application implements each one (`app/settings/engine-settings.schema.ts`).

**Resources → Characters** edits `characters/*.json`: how a *kind* of character is drawn,
and what may be chosen about one (ADR-0028, ADR-0029). A character is composed
of **sprites** on a pixel canvas it declares — up to 256 a side, chosen by
whoever authors it.

A definition is two lists. **Parameters** are the choices it offers, written in
the same control vocabulary as the settings. **Layers** are the pieces it is
drawn from, back to front; each holds variants, and a variant says which
parameter values it answers to (`when`), which image it draws, and where that
image goes on the canvas (`rect`, in whole pixels). The first variant whose
conditions hold is the one drawn, so specific ones go first; a layer with no
match draws nothing, which is how a cape is made optional.

Pick an image from the content directory or upload one with the ⤒ button — the
box is fitted to the image's own pixel size, because any other size stretches
pixel art. A **tint** recolours a sprite, either with a fixed colour or from a
parameter: one greyscale hair sprite serves every hair colour instead of one
image per colour.

The scene is also where the sprites are **painted** (ADR-0030), and it always
is — there is no paint mode to turn on. The composed figure is the drawing
surface for the image behind the open layer: pencil, eraser, eyedropper (or hold
Alt), an opacity, undo with Ctrl+Z, and a whole-number zoom from the file bar or
Ctrl with the wheel. The palette offers the colours the character already uses,
most-used first, so two layers stay on the same browns. A layer with no image
can create a transparent one at its box's size.

With the **Animation** panel open and an animation selected, a drag on the stage
moves the open node at that frame instead of painting it — that is how a pose is
authored, and the hint under the stage says which of the two a drag will do
(ADR-0039).

*Flat* switches the scene to that one sprite seen alone, with the same tools
over the same buffer — a stroke in one view is already in the other.

While painting, the edited layer is drawn **without its tint**: what the pencil
writes is the file itself, so two greys are compared as greys. Pixels live in
the tab until *Save images* writes them, and saving the character writes them
too.

The preview on the right is the shipping pipeline, not a mock-up: the controls
are the player's own `control-field`, the resolution is the Rust resolver, and
the drawing is the renderer the game will use — flip *Armour* to `plate` and the
chest swaps sprite in front of you. It draws the canvas bounds and a box around
the layer you are editing, and zooms by whole numbers so pixels stay square.

Nothing here is player-specific. `human_player` is the definition this project
ships; the same screen creates a merchant, a goblin or a dragon, and `category`
is filing only — the renderer never reads it. Size is the **canvas**: a 32×32
goblin next to a 128×128 knight needs no scale factor.

Saving writes the file, declares it in `project.json` if it is new, and creates
every label key it names in every language.

**Languages** is the translation table: every key, every language, side by side,
with a filter for what is still untranslated. Saving rewrites one file per
language and namespace, declares any new namespace in `project.json`, and hands
the files back to the engine — so a key added here is usable everywhere else
straight away, no reload. Keys the *application* ships are listed greyed —
typing over one overrides it for this project.

Keys are **created where they are used**: type a `labelKey` in the title or
settings editor, save, and the key exists in every language, empty, waiting for
its text here (ADR-0027). Until someone writes it, that key shows on screen as
itself.

### Play it

Press **Validate** to check the open map, then open `/play` — the editor's own
documents are what Play mode loads, so there is nothing to save first.

In Play mode:

- Highlighted hexes are the engine's `legalMoves` — computed in Rust, not
  derived by the UI.
- **Click a highlighted hex** to move. The tick badge increments and the
  monsters take a step.
- Click anywhere else on the map: the move is refused, and a banner explains
  why. The tick does not move.
- **Wait (1 tick)** spends a turn without moving.
- Change the seed and press **Restart**. The same seed plus the same clicks
  always produce the same game.

---

## Commands

| Command | What it does |
|---|---|
| `npm install` | Install JS dependencies, including `wasm-pack`. |
| `npm run wasm:build` | Build the engine to `apps/web/public/wasm/` (release). |
| `npm run wasm:build:dev` | Same, unoptimised — faster to build, slower to run. |
| `npm run dev` | Start the authoring content server, then the Angular dev server in front of it. |
| `just run` | The three quick-start commands in one. Extra flags reach `ng serve` untouched: `just run --host 0.0.0.0` also serves the app to the local network. |
| `npm run build` | Production bundle into `apps/web/dist/web/browser/` (with the editor). |
| `just deliver` | Client delivery: the desktop executable and its installers, collected in `deliveries/`. |
| `just desktop` | Run the desktop shell against the dev server. |
| `just icons` | Regenerate the icon set from `apps/desktop/icons/icon.svg`. |
| `npm run build:deliver` | Just the editor-free web bundle, without the shell. |
| `npm test` | Rust tests, then TypeScript tests, then the script tests. |
| `npm run test:rust` | `cargo test --workspace` (368 tests, no browser needed). |
| `npm run test:web` | Vitest (236 tests, including real WASM integration). |
| `npm run test:scripts` | `node --test` over `scripts/` — the content server's path rules, and the shape of the shipped tile art. |
| `npm run lint:rust` | `cargo clippy -D warnings` and `cargo fmt --check`. |
| `npm run check` | Lint plus every test. |
| `just check-desktop` | The desktop shell's own clippy, rustfmt and tests. |

`node scripts/generate-tile-art.mjs` redraws the shipped tile art in
`content/assets/tiles/`: for each of the seven terrains, eight **flat** images
for a top-down map and eight **surfaces** for an isometric one
(`docs/adr/ADR-0037-a-flat-map-is-drawn-from-flat-art.md`), plus three elevation
ladders — dirt, rock and mountain — at three levels of eight variants, one
directory per tile. The other four terrains borrow a ladder when a cell asks for
one (`docs/adr/ADR-0036-a-cell-may-choose-its-tile-art.md`). It is a **seeder**:
nothing in the build runs it, the images it writes are ordinary art the asset
editor edits from then on, and re-running it overwrites whatever has been
painted since.

After changing Rust code, re-run `npm run wasm:build` and refresh the browser —
Angular does not need rebuilding, because the engine is served as a static
asset.

---

## How the Angular ↔ WASM boundary works

Full specification: **`docs/wasm-api.md`**. The short version:

**Angular owns** UI, the editor, input, presentation and renderer
orchestration. **Rust owns** `GameState`, the hex grid, movement validation,
tick processing, monster movement, deterministic RNG and every game rule.

One click follows exactly this path:

```text
click a hex
  → EngineService.dispatch({ type: 'moveTo', to: [3, 9] })          Angular
    → validate · move player · tick++ · move monsters               Rust/WASM
  ← CommandResult { accepted, events[], state }
→ renderer draws the new state                                      Canvas
```

Three properties keep this honest:

1. **Commands in, snapshots out.** There is no setter for a position or a tick.
   The UI cannot move the player; it can only ask.
2. **The map crosses once.** Terrain travels as a single `Uint8Array` of palette
   indices, fetched once per world. A snapshot never contains the map, so it
   stays a few hundred bytes whatever the map's size. Rendering a large world
   costs one transfer, not one call per tile.
3. **The engine answers rules questions.** `legalMoves` comes from Rust, so the
   highlighted hexes and the accepted commands cannot disagree.

The generated `wasm-pack` output is published as a static asset and imported at
runtime, so the Rust build and the Angular build stay independent.

---

## Repository layout

```text
crates/
  world/           hex coordinates · content definitions · validation · packed grid
  simulation/      GameState · tick pipeline · movement rules · monster AI · RNG
  engine/          facade · DTOs · content registry · string contract
  wasm/            wasm-bindgen pass-through (no logic)

apps/web/src/
  core/hex/        offset ↔ axial transforms, pointy-top pixel layout
  content/         authored document model + canonical serialiser
  renderer/        framework-free Canvas renderer, camera, sprite registry
  engine/          boundary types + runtime WASM loader
  app/             Angular shell, services, editor modules, play page
    features/editor/  shell + map, title, settings, locale and resource
                      editors, and one placeholder page (ADR-0019, ADR-0039)
    build-features*.ts, app.routes*.ts   dev vs client build seam (ADR-0018)

content/
  project.json     which files make one game, and where it starts
  tilesets/        mvp_terrain.json
  worlds/          demo_world.json, demo_refuge.json

docs/
  content-format.md   the authored file schema
  wasm-api.md         the engine boundary
  data-model.md       definitions vs. runtime state
  architecture.md     crate boundaries and seams
  adr/                architecture decisions
apps/desktop/
  src/main.rs      the window, and nothing else
  src/steam.rs     the Steam seam, off by default (ADR-0020)
  tauri.conf.json  window, bundle targets, webview CSP
  icons/icon.svg   source of every generated icon

scripts/
  content-dir.mjs          resolves which content directory this run works on
  content-server.mjs       serves and writes it, in development only
  content-paths.mjs        the path and file-type rules that server enforces
  dev.mjs                  starts the content server, then `ng serve` in front of it
  sync-content.mjs         mirrors the content directory into apps/web/public/ for a build
  tauri.mjs                runs the Tauri CLI on apps/desktop (and fixes WSL's PATH)
  verify-client-build.mjs  proves the shipped bundle has no editor
  collect-bundles.mjs      gathers installers and the bare executable
deliveries/             `just deliver` output
```

`apps/web/public/wasm/`, `apps/web/public/content/` and `deliveries/` are
generated and git-ignored.

---

## Content

`content/` at the repository root is the **fixture**: the smallest valid project
that proves the engine works, and what every test suite reads. A game is
authored somewhere else — copy `.env.example` to `.env` and name its content
directory:

```bash
cp .env.example .env
# INSULAIRE_CONTENT_DIR=/absolute/path/to/your-game/content
npm run dev        # serves that directory, and lets the editor write into it
```

`npm run dev` starts a small authoring server on the loopback interface and
proxies `/content` and `/api/content` to it, so an image dropped into the editor
lands on disk and appears immediately. Nothing in the *game* talks to it: builds
mirror the directory into the bundle, and the delivered executable embeds it
(`docs/adr/ADR-0022-authoring-content-workspace.md`).

The file schema is specified in **`docs/content-format.md`**.

### Languages

No string on screen is written in the source. A template names a key, and the
key resolves against the language in use (`docs/adr/ADR-0023-localised-content-keys.md`):

```text
content/locales/en/menu.json    { "buttons": { "newGame": "New game" } }
content/locales/fr/menu.json    { "buttons": { "newGame": "Nouvelle partie" } }
                                 →  menu.buttons.newGame
```

`project.json` declares the languages and their files; the file's `id` in the
manifest is the namespace prefixed to its keys. The application ships its own
interface text in English and French, so the editor is legible before a project
loads — and content may override any of it. A language the manifest declares
without a loaded file is a **load error**; a key one language is missing is a
warning, and the default language's text is shown instead.

```jsonc
{
  "id": "demo_world",
  "schemaVersion": 1,
  "width": 20, "height": 20,
  "orientation": "pointy",
  "projection": "isometric",                              // or "topDown"
  "tileSetId": "mvp_terrain",
  "defaultTile": "grass",
  "tiles":    [ { "at": [4, 1], "tile": "mountain", "elevation": 4 } ],  // only non-default cells
  "entities": [ { "id": "player_1", "templateId": "player", "at": [4, 10] } ],
  "locations":[ { "id": "loc_camp", "at": [3, 11], "name": "Camp" } ],
  "links":    [ { "id": "link_refuge_door", "at": [3, 10],                // a door
                  "targetWorld": "demo_refuge", "targetAt": [3, 4] } ]
}
```

`content/project.json` says which files make up the game and where it starts:

```jsonc
{
  "id": "insulaire",
  "schemaVersion": 1,
  "startWorld": "demo_world",
  "tileSets": [ { "id": "mvp_terrain", "path": "tilesets/mvp_terrain.json" } ],
  "worlds":   [ { "id": "demo_world",  "path": "worlds/demo_world.json" },
                { "id": "demo_refuge", "path": "worlds/demo_refuge.json" } ]
}
```

Positions are odd-r offset pairs `[col, row]`. Cells are stored sparsely, so a
20×20 world with a lake and a mountain ridge is 82 lines, and painting one hex
changes one line of the diff.

Files are loaded over HTTP as static assets. **`file://` does not work** for
this app: browsers block ES module and WebAssembly loading from the local
filesystem (ADR-0012).

Any static host works, with one piece of configuration: the app uses path-based
routing, so unknown paths must fall back to `index.html` — otherwise
`/play` 404s on a page refresh. With `http-server` that is the `--proxy` flag:

```bash
npm run build
npx http-server apps/web/dist/web/browser -p 8080 --proxy "http://localhost:8080?"
```

Most hosts express the same thing as a rewrite rule (Netlify `_redirects`,
Vercel `rewrites`, nginx `try_files $uri /index.html`). Serve `.wasm` as
`application/wasm` — `http-server` and every host listed above already do.

No backend, no database, no content service.

---

## Delivering the game to a client

The client receives an **executable**: a Tauri 2 desktop application that hosts
the same web bundle and the same WASM engine in a native window
(**ADR-0020**). No browser, no server, no installation ritual.

```bash
just deliver
```

It builds the engine, mirrors `content/`, builds the Angular app with the
`deliver` configuration, wraps it in the desktop shell, verifies what went in
and collects the result into `deliveries/` (git-ignored).

That build is the **game only**: `app.routes.deliver.ts` replaces
`app.routes.ts`, so the editor is not merely hidden — it is absent from the
bundle, and `scripts/verify-client-build.mjs` fails the delivery if any chunk
still contains it (ADR-0018). The app starts on `/play`, loads
`content/project.json` and begins on its `startWorld`.

**One platform per machine.** Tauri cannot cross-compile, so `just deliver`
produces what the machine it runs on can produce:

| Platform | Built on | Artefacts |
|---|---|---|
| Windows | Windows | `.msi`, `.exe` (NSIS) |
| macOS | macOS (arm64 and x86_64 separately) | `.app`, `.dmg` |
| Ubuntu, Debian | `ubuntu-22.04` — the oldest supported glibc | `.deb` |
| Fedora and relatives | same | `.rpm` |
| Arch and everything else | same | `.AppImage` |

`.github/workflows/release.yml` builds that matrix on a tag and drafts a
release. `deliveries/` also receives the **bare executable**, which is a
complete build — the interface and the engine are embedded in it — and is what a
Steam depot takes.

Steam itself is a seam, not an integration: `apps/desktop/src/steam.rs` is
inert unless the crate is built `--features steam`, because the Steamworks SDK
is not redistributable (ADR-0020).

Building on Windows needs the **MSVC C++ build tools** ("Desktop development
with C++" in the Visual Studio Build Tools) and the **WebView2 runtime**, which
current Windows versions already carry. `just` finds no `sh` there, so the
justfile runs its recipes through PowerShell (`set windows-shell`); the commands
themselves are the same ones.

Building on Linux needs the GTK and WebKit development packages:

```bash
sudo apt install libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev \
  libsoup-3.0-dev libgtk-3-dev librsvg2-dev patchelf
```

```bash
sudo pacman -S webkit2gtk-4.1 libsoup3 gtk3 librsvg patchelf
```

`linuxdeploy`, which builds the AppImage, reports everything that goes wrong to
it as the same bare `failed to run linuxdeploy`. `scripts/tauri.mjs` therefore
handles the three host conditions known to trigger it, so that none of them
costs a release build to identify:

- **Under WSL**, it drops the Windows `/mnt/…` entries from `PATH` before
  invoking the CLI. `linuxdeploy` walks every `PATH` entry, hits a
  `Permission denied` inside `/mnt/c/WINDOWS/...`, and throws.
- **`patchelf`** is checked before the build and reported as itself. It is in
  the package lists above, so the usual cause of its absence is not a missing
  package but a version manager — `pyenv`, `asdf` — whose shim sits earlier on
  `PATH` and fails for anything not installed in the selected environment.
- **On a host that relocates its libraries with relr** (`.relr.dyn`, Arch and
  any recent distribution; not the `ubuntu-22.04` the release workflow builds
  the AppImage on), it sets `NO_STRIP`. The `strip` bundled inside
  `linuxdeploy` predates that section type and fails on every library it is
  handed. The resulting AppImage is larger, which beats not existing.

Nothing to do by hand for any of them beyond installing `patchelf`.

The web build has not gone anywhere: it is what `npm run dev` serves, what the
editor runs in, and it still hosts fine on any static host, `<base href>`
relative, with an `index.html` fallback for `/play`.

---

## Testing

```bash
npm test
```

**Rust (162 tests, `cargo test`)** — hex neighbours, distance and coordinate
conversion; bounds checking; world loading and validation; movement validation;
that a valid move advances the tick and an invalid one advances nothing; that
monsters move after each tick; deterministic monster behaviour; deterministic
RNG; map links, including that a door fires on entry and never on presence, that
entering a world carries the tick and the RNG stream, and that an unresolved
door degrades instead of ending the session; and the boundary's string contract.

`crates/engine/tests/shipped_content.rs` runs against the **real files** in
`content/` — so the demo world cannot silently rot, a terrain edit that walls
the monsters off from the player fails the build, and the shipped door is walked
through in both directions.

**TypeScript (69 tests, Vitest)** — coordinate transforms mirrored against the
Rust suite; pixel ↔ hex round trips and viewport culling; the isometric
projection and the hit-testing that has to survive it, including which cell wins
when a hill covers the one behind it; the editor's document model, its link
editing and its sparse export; that both shipped worlds and `project.json` round
trip byte for byte; and `engine-integration.spec.ts`, which drives the
**real** `wasm-pack` output with the **real** authored content through the same
types the application uses — including the whole change-map loop.

---

## Known limitations

- **Monster AI has no pathfinding.** A chaser walks greedily towards the player
  and stalls in dead ends. This is documented behaviour, not a bug; see
  `crates/simulation/src/ai.rs`.
- **Entity templates are built into Rust**, not content files. Worlds reference
  them by id, so moving them into `content/` later needs no world change.
- **One tile set.** The editor cannot author tile sets; it consumes
  `mvp_terrain.json`.
- **A map link carries the session, not the character.** Tick and RNG survive a
  door; the player entity is the one the target map authors, so future per-player
  state (health, inventory, deck) will need `GameState::enter_world` to carry it
  (ADR-0017).
- **Only the `enter` trigger** for map links; `interact` is in the schema and
  rejected by validation.
- **A tick still advances one map.** Zones are authored, validated and edited,
  but the zone-wide tick they exist for is not written: maps outside the one the
  player stands on stay frozen (ADR-0021).
- **The scenario editor is a placeholder** — a registered tab describing what
  it will own, with no implementation (ADR-0019). So are three of the five
  resource categories: objects, decorations and effects (ADR-0039).
- **Characters are authored but not yet worn.** Definitions and the generic
  creation workflow are edited, validated and resolved into drawable sprites,
  but the player-facing creation route does not yet feed its result into
  `GameState`, and map entities still use `EntityTemplate` visuals (ADR-0028,
  ADR-0042).
- **A character is one still frame.** No animation, no directions, no sprite
  sheets: a variant names one image (ADR-0029).
- **The shipped character's sprites are placeholders** — eight small PNGs under
  `content/assets/characters/`, there to exercise the pipeline, not to be
  looked at.
- **No undo/redo outside the pixel tools**, no copy/paste in the editor. Paint
  mode undoes the last 32 strokes, in memory only (ADR-0030); nothing else in
  the editor undoes anything.
- **The pixel tools are for retouching**, not for drawing a sprite from
  scratch: three tools, no fill, no selection, no brush size, no sub-layers, no
  sprite sheets. Art made elsewhere still arrives through the ⤒ upload button
  (ADR-0030, ADR-0039).
- **A tile is painted on its hexagon** — there is no flat pixel view for tiles,
  though the hexagon zooms like any other surface (ADR-0039).
- **Only `pointy` orientation** is implemented; `flat` is in the schema and
  rejected by validation.
- **Isometric relief is drawn, not simulated.** `elevation` lifts a cell and
  gives it a side face; no rule reads it — movement cost, passability and
  adjacency are unaffected (ADR-0016).
- **Isometric entities are ordered against terrain, not against each other.**
  Two entities on the same row with very different elevations can overlap in the
  wrong order.
- **Isometric mode gives up whole-viewport terrain batching**: it batches per
  visible row, because elevated cells overlap the row behind them.
- **The Linux desktop shell inside WSLg is not a performance reference.** WSL
  exposes `/dev/dri/card0` as *vgem*, a virtual device that renders nothing —
  the real GPU is behind `/dev/dxg` — so WebKitGTK falls back and prints
  `libEGL warning: DRI3 error: Could not get DRI3 device`. Canvas frames there
  cost orders of magnitude more than the same build costs in a browser on the
  same machine, and the pointer lags the highlight because WSLg presents the
  window through RDP while Windows draws the cursor natively. Measure the
  renderer in `just run`, or in a build made on the target platform.
- **Palette limit of 256 tiles**, because the packed buffer is one byte per cell.
- **No save/load of a game in progress.** The RNG state is serialisable and
  travels in every snapshot, but no save system is built on it yet.
- The crates carry no `license` field; add one before publishing anything.

---

## Architecture decisions

Read in order:

1. ADR-0001 — UI / engine separation
2. ADR-0002 — Rust/WASM engine
3. ADR-0003 — authored and data-driven worlds
4. ADR-0004 — tick-based simulation
5. ADR-0005 — scenario runtime *(not implemented yet)*
6. ADR-0006 — content data format
7. ADR-0007 — rendering
8. ADR-0008 — world editor
9. ADR-0009 — assets and tilesets
10. ADR-0010 — save system *(not implemented yet)*
11. ADR-0011 — deterministic RNG
12. ADR-0012 — static distribution
13. **ADR-0013 — engine API: commands and compact snapshots**
14. **ADR-0014 — hex coordinate model**
15. **ADR-0015 — shared content validation**
16. **ADR-0016 — isometric projection**
17. **ADR-0017 — map links and multi-map sessions**
18. **ADR-0018 — client delivery build**
19. **ADR-0019 — editor modules**
20. **ADR-0020 — desktop executable (Tauri 2), Steam seam**
21. **ADR-0021 — map zones** *(zone-wide ticks not implemented yet)*
22. **ADR-0022 — authoring content workspace and the dev-only content server**
23. **ADR-0023 — every displayed string is a key, resolved per language**
24. **ADR-0024 — the client opens on an authored title screen**
25. **ADR-0025 — engine settings belong to the shell, game settings are content**
26. **ADR-0026 — the session outlives the route, and the title screen ends it**
27. **ADR-0027 — naming a key creates it; an untranslated key is a warning**
28. **ADR-0028 — characters are definitions plus customisations, resolved in Rust**
29. **ADR-0029 — characters are composed sprites on a declared pixel canvas**
30. **ADR-0030 — the editor paints the sprites it composes**
31. **ADR-0031 — characters animate by a layer hierarchy and whole-pixel offsets**
32. **ADR-0032 — a keyframe may name a sprite, and an animation may be another one mirrored**
33. **ADR-0033 — an animation sets pose values, and variants choose from them**
34. **ADR-0034 — a layer's box is measured from the joint it hangs off**
35. **ADR-0035 — tile art is authored per level and resolved, never transformed**
36. **ADR-0036 — a cell may choose its tile art, and a cliff may be borrowed**
37. **ADR-0037 — a flat map is drawn from flat art, or from colour**
38. **ADR-0038 — a map is drawn from shared pictures, and only once it has them**
39. **ADR-0039 — one editor for everything the game is drawn from**
40. **ADR-0040 — tile art travels as one bundle**
41. **ADR-0041 — a cliff is stacked in bands**
42. **ADR-0042 — character creation is a generic authored workflow**

`CLAUDE.md` contains project-level instructions for Claude Code and other coding
agents.

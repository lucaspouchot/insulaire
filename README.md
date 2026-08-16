# Hex Engine

A browser-based turn-based game engine with an **authored** hexagonal world, an
Angular UI/editor, and a Rust/WebAssembly simulation.

This repository currently contains the **MVP vertical slice**: enough of the
stack to prove the architecture works end to end, and nothing more.

```text
  Editor  ──►  WorldDefinition (JSON)  ──►  Rust/WASM  ──►  Play
   paint            export / import          validate       click a hex
   place            content/worlds/          simulate       watch the tick
```

---

## What works today

- Load an authored hex world from a JSON file.
- Render it to a Canvas with pan, zoom, hover, selection and viewport culling.
- Paint terrain, place a player and monsters, validate, export and import.
- Start a playable test game **from the world the editor is holding**.
- Click an adjacent hex: the engine validates it, moves the player, advances
  the tick by one, moves every monster one step towards the player, and returns
  what changed.
- An invalid move changes nothing — no movement, no tick, no randomness.
- Live display of the tick, every entity position, the engine's RNG state and
  the event stream coming out of Rust.

Deliberately **not** implemented yet: scenarios, combat, deckbuilding,
pathfinding, procedural generation, save/load UI, an asset pipeline, a backend.

---

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| **Node.js** | ≥ 20.19, or ≥ 22.12 | `node --version`. Angular 21 requires this. |
| **Rust** | ≥ 1.82 (stable) | Install from <https://rustup.rs>. |
| **wasm32 target** | — | `rustup target add wasm32-unknown-unknown` |

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

Open <http://localhost:4200>. You land in the **Editor**, already showing
`content/worlds/demo_world.json`.

The header shows what the engine actually is:

```text
● Rust engine · wasm32 · 32-bit · v0.1.0
```

That line is read out of the running WebAssembly module (`engineInfo()`
reports `std::env::consts::ARCH` from inside the binary), so it is the engine
identifying itself, not a label.

> If the badge says **Engine failed**, you skipped `npm run wasm:build`.

---

## Walkthrough

### Edit a world

1. Open **Editor**.
2. Pick a terrain in the palette (movement cost `0` means impassable).
3. Click or **drag** on the map to paint. Right-drag or middle-drag pans, the
   wheel zooms, `Fit` re-frames.
4. Switch the tool to **Player** or **Monster** and click a hex to place one. A
   world has exactly one player; placing a new one moves it.
5. **Erase entity** removes whatever stands on a hex.
6. Press **Validate**. The report comes from Rust — the same validator the
   runtime runs at load time — and points at the exact field, e.g.
   `entities[3].at · entity 'monster_3' stands on an impassable tile at [5, 5]`.
7. **Export JSON** downloads the world. Drop it into `content/worlds/` to make
   it part of the repository, or re-load it later with **Import JSON**.

Edits are mirrored into `localStorage`, so a refresh does not lose work.
**Reload demo** throws that away and re-reads the file from `content/`.

### Play it

Press **Validate & Play**. It refuses to navigate while the world has errors.

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
| `npm run dev` | Mirror `content/`, then start the Angular dev server. |
| `npm run build` | Production bundle into `apps/web/dist/web/browser/`. |
| `npm test` | Rust tests, then TypeScript tests. |
| `npm run test:rust` | `cargo test --workspace` (126 tests, no browser needed). |
| `npm run test:web` | Vitest (46 tests, including real WASM integration). |
| `npm run lint:rust` | `cargo clippy -D warnings` and `cargo fmt --check`. |
| `npm run check` | Lint plus every test. |

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
  app/             Angular shell, services, editor page, play page

content/
  tilesets/        mvp_terrain.json
  worlds/          demo_world.json

docs/
  content-format.md   the authored file schema
  wasm-api.md         the engine boundary
  data-model.md       definitions vs. runtime state
  architecture.md     crate boundaries and seams
  adr/                architecture decisions
scripts/
  sync-content.mjs    mirrors content/ into apps/web/public/
```

`apps/web/public/wasm/` and `apps/web/public/content/` are generated and
git-ignored.

---

## Content

Authored content lives at the repository root in `content/` and is specified in
**`docs/content-format.md`**.

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
  "locations":[ { "id": "loc_camp", "at": [3, 11], "name": "Camp" } ]
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

## Testing

```bash
npm test
```

**Rust (134 tests, `cargo test`)** — hex neighbours, distance and coordinate
conversion; bounds checking; world loading and validation; movement validation;
that a valid move advances the tick and an invalid one advances nothing; that
monsters move after each tick; deterministic monster behaviour; deterministic
RNG; and the boundary's string contract.

`crates/engine/tests/shipped_content.rs` runs against the **real files** in
`content/` — so the demo world cannot silently rot, and a terrain edit that
walls the monsters off from the player fails the build.

**TypeScript (61 tests, Vitest)** — coordinate transforms mirrored against the
Rust suite; pixel ↔ hex round trips and viewport culling; the isometric
projection and the hit-testing that has to survive it, including which cell wins
when a hill covers the one behind it; the editor's document model and its sparse
export; and `engine-integration.spec.ts`, which drives the
**real** `wasm-pack` output with the **real** authored content through the same
types the application uses.

---

## Known limitations

- **Monster AI has no pathfinding.** A chaser walks greedily towards the player
  and stalls in dead ends. This is documented behaviour, not a bug; see
  `crates/simulation/src/ai.rs`.
- **Entity templates are built into Rust**, not content files. Worlds reference
  them by id, so moving them into `content/` later needs no world change.
- **One tile set.** The editor cannot author tile sets; it consumes
  `mvp_terrain.json`.
- **No undo/redo**, no layers, no copy/paste in the editor.
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

`CLAUDE.md` contains project-level instructions for Claude Code and other coding
agents.

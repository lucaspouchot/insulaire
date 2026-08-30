# CLAUDE.md — Insulaire

## Mission

Build a browser-based turn-based game engine and a companion hex-world editor.

The game world is **authored**, not procedurally generated. Maps, important entities, locations, events, timers and scenario progression are defined as editable content.

## Non-negotiable architecture

- Angular/TypeScript = UI, editor, orchestration and tooling.
- Rust/WASM = game rules, simulation, AI, pathfinding, deterministic RNG and combat.
- Canvas/WebGL = world and entity rendering.
- The GameState belongs to the Rust engine, not Angular components.
- Content must be data-driven and versioned.
- Runtime and editor should share content models and validation whenever practical.
- Playing a local game must not require a backend.
- Saves must never depend on Angular component state.

## World

The world is an authored hexagonal map.

A tile may reference:
- terrain
- tile/texture
- elevation
- flags
- decoration
- occupation
- gameplay tags

Maps may be large. The renderer must only draw the area relevant to the camera.

## Simulation

Every valid player action advances the world by one tick.

Conceptual order:
1. validate action
2. apply player action
3. resolve immediate effects
4. advance world systems
5. advance scenario
6. resolve triggers/events
7. produce observable state changes
8. render

A rejected action does not advance the tick unless explicitly defined by a game rule.

## Scenario

Scenario content is data-driven:
- acts
- phases
- objectives
- triggers
- conditions
- countdown timers
- major events
- flags
- consequences

The engine must not contain scenario-specific `if` statements.

## Combat

Combat is another phase of the same game state:
- no world movement
- deck
- draw pile
- hand
- discard pile
- energy/costs
- cards
- effects
- statuses
- turns

## Editor

The editor is an Angular application using the same content definitions as the runtime.

Initial capabilities:
- create/open a map
- paint hex tiles
- manage layers
- place/remove entities
- manage points of interest
- import assets
- create/manage tilesets
- define gameplay tags
- edit scenario data
- validate content
- export content

The editor must not duplicate game rules.

## Performance

Avoid:
- one Angular component per hex
- one JS object per simulated entity
- full world copies every tick
- one WASM/JS call per tile

Prefer:
- compact structures/buffers
- controlled snapshots or diffs
- viewport culling
- texture caching
- batched rendering

## Versioning

The project is **pre-1.0**. Until a 1.x release, a breaking change is the
preferred answer, not a last resort: rename crates and types, change a schema,
move a storage key, drop a field. Do not write migration shims, dual readers,
deprecation aliases or fallbacks to keep old names, old files or old browser
state working — that compatibility has no users yet, and carrying it is what
makes the eventual 1.0 shape worse.

What this does **not** excuse:

- a schema change still bumps `WORLD_SCHEMA_VERSION` / `TILE_SET_SCHEMA_VERSION`
  and is still written down in `docs/content-format.md` (`.claude/rules/specs.md`);
- every caller, test and document still moves in the same change — "breaking" is
  not "leaving it inconsistent";
- the gates and the smoke run still have to pass.

Say plainly in the commit message what breaks and what is discarded, so the
change is legible later. Once 1.x ships, this section is void and compatibility
becomes a real constraint.

Every push that changes shipped code carries a **patch or minor** bump; the
`commit-and-push` skill owns that step and its script writes all nine version
sites at once. **Major bumps are the author's, by hand** — never bump it.

## Language Rules
- Write all source code, code comments, variable names, and git commit messages in **English**.
- Converse, answer questions, and explain thoughts during the session in language describe in env AGENT_LANG=<lang> in .env, default to **en** for english

## Rules for Claude

Before changing an architectural decision:
1. read the relevant ADRs;
2. explain the conflict;
3. propose a new ADR if needed;
4. never silently break an existing decision.

Before a major implementation:
1. identify required data models;
2. identify the Angular/WASM boundary;
3. define engine tests;
4. implement engine logic independently of the DOM where possible;
5. connect the UI afterward.

Every image is drawn by **PixelLab**, through the
`generate-images-with-pixellab` skill — tile art, character layers, portraits,
props, title art, icons, a banner, a rough. Whatever the destination, and not
only what ships in `content/`. Diagrams, charts and mockups made of real markup
are not images in this sense and are not generated. When the PixelLab balance
does not allow a call, say so and ask — never substitute a placeholder for the
image that was asked for without saying it.

## Initial non-goals

Do not add without an explicit requirement:
- backend services
- multiplayer
- procedural world generation
- complex ECS architecture
- physics engine
- unrestricted scripting language

Desktop packaging **was** on this list; the requirement is now explicit and it is
lifted. The client delivery is a Tauri 2 executable (ADR-0017). It hosts the same
web bundle and the same WASM engine — the shell owns the window and native
services only, never a game rule. Electron remains excluded.

## Agent skills

### Issue tracker

Issues live as markdown files under `.scratch/<feature-slug>/` in this repo. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, used verbatim as label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` at the root plus `docs/adr/`. See `docs/agents/domain.md`.

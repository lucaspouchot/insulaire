# CLAUDE.md — Hex Engine

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

## Initial non-goals

Do not add without an explicit requirement:
- backend services
- multiplayer
- procedural world generation
- complex ECS architecture
- physics engine
- unrestricted scripting language
- Electron/Tauri desktop packaging

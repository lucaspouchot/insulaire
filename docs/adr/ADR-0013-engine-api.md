# ADR-0013 — Shape the Engine API as Commands and Compact Snapshots

## Status
Accepted

## Context

ADR-0001 and ADR-0002 put the GameState in Rust and the UI in Angular, but did not say what actually crosses between them. Two failure modes were easy to fall into:

- exposing the internal Rust object graph to JavaScript, which freezes the engine's internals into the UI contract;
- calling into WASM per tile, which makes a large map unaffordable to render.

## Decision

The engine exposes one facade — `insulaire_engine::Engine` — with an explicit, small API:

```text
loadTileSet(json)    -> LoadOutcome
loadWorld(json)      -> LoadOutcome
validateWorld(json)  -> ValidationReport        (registers nothing)
contentSummary()     -> ContentSummary
worldView(worldId)   -> WorldView               (once per world)
terrainBuffer(id)    -> Uint8Array              (once per world)
createGame(id, seed) -> GameSnapshot
snapshot()           -> GameSnapshot
dispatch(command)    -> CommandResult
endGame()
```

Three rules govern it:

1. **Commands in, snapshots out.** The only way the host changes the simulation is `dispatch`. There is no setter for a position, a tick or an entity.
2. **The map crosses once, packed.** Terrain travels as a single `Uint8Array` of palette indices, row-major in offset coordinates, fetched once per world. A `GameSnapshot` never contains the map, so it stays a few hundred bytes whatever the map size.
3. **The engine answers rules questions.** `GameSnapshot.legalMoves` is computed in Rust by running the same validation a real command would. The UI highlights that list rather than deriving adjacency itself.

Structured payloads cross as JSON strings; the terrain buffer does not use JSON. Errors cross as a JSON `EngineErrorPayload` with a stable `code`.

An *illegal* command is not an error: `dispatch` returns `accepted: false` with a `rejection`, and the state is untouched.

The string contract lives in `insulaire_engine::JsonEngine` rather than in the WASM crate, so it is covered by ordinary `cargo test`. `insulaire-wasm` is a pass-through with no logic of its own.

## Consequences

Positive:
- rendering a 2048x2048 world costs one 4 MiB transfer, not four million calls;
- the engine's internals can change freely as long as the DTOs hold;
- the whole boundary is testable natively, without a browser;
- the UI cannot disagree with the rules it displays, because it does not implement them.

Negative:
- every new piece of information the UI needs requires a deliberate DTO change;
- JSON string payloads are parsed twice (Rust serialises, JS parses). Measured against snapshot sizes of a few hundred bytes this is irrelevant; if it ever matters, the change is local to `crates/engine/src/json.rs` and `crates/wasm/src/lib.rs`.

## Rule

Angular may not compute a rules answer that the engine could give it. If the UI needs to know whether something is allowed, the engine must expose it.

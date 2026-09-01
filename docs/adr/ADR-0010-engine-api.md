# ADR-0010 — Shape the Engine API as Commands and Compact Snapshots

## Status
Accepted

## Context

ADR-0001 puts the `GameState` in Rust and the UI in Angular, but does not say
what actually crosses between them. Two failure modes were easy to fall into:

- exposing the internal Rust object graph to JavaScript, which freezes the
  engine's internals into the UI contract;
- calling into WASM per tile, which makes a large map unaffordable to render.

## Decision

The engine exposes one facade — `insulaire_engine::Engine` — governed by four
rules rather than by a fixed method list.

**Commands in, snapshots out.** The only way the host changes the simulation is
`dispatch`. There is no setter for a position, a tick or an entity. An *illegal*
command is not an error: `dispatch` returns `accepted: false` with a `rejection`,
and the state is untouched.

**Content is loaded, then referred to by id.** `loadWorld`, `loadTileSet`,
`loadCharacter`, `loadDecoration`, `loadObject`, `loadLocale`, `loadSettings`,
`loadTitleScreen` and `loadCharacterCreation` register a JSON file and return a
`LoadOutcome`; `loadProject` then validates the manifest against what is actually
loaded. Every kind has a matching `validate*` that registers nothing, which is
what the editor calls, and a `resolve*`/`preview*` pair — the first for
registered content, the second for a definition the editor is still writing — so
the editor's preview and the runtime are the same Rust code (ADR-0012).

That set is derived, not written. A content kind is one `ContentKind`
implementation — what it is called, what its files parse into, whether a project
holds many of them or one, and which `insulaire_world` validator judges it — and
`Engine::load`, `Engine::validate`, `Engine::definition`, `Engine::only` and
`Engine::ids` are generic over it. The boundary methods a kind owes are one row
in `crates/engine/seam.json`. The `resolve*`/`preview*` pair is not derived and
is not meant to be: its arguments are what makes a kind that kind — a decoration
resolves at a moment of an animation, a character against a customisation — so
each is declared on its own. A locale file is not a content kind: it has no id,
it is keyed by language and namespace, and several files merge into one bundle
(ADR-0020).

**Bulk data crosses once, packed.** `terrainBuffer`, `elevationBuffer` and
`presenceBuffer` are `Uint8Array`s of one byte per cell, row-major in offset
coordinates, fetched once per world. A `GameSnapshot` never contains the map, so
it stays a few hundred bytes whatever the map size.

**The engine answers rules questions.** `GameSnapshot.legalMoves` is computed in
Rust by running the same validation a real command would. The UI highlights that
list rather than deriving adjacency itself.

Structured payloads cross as JSON strings; the packed buffers do not. Errors
cross as a JSON `EngineErrorPayload` with a stable `code`. Anything a game
carries into a session crosses on the way in — `createGame(worldId, seed,
settings)` takes the resolved game settings (ADR-0022) — rather than being
reachable afterwards.

The string contract lives in `insulaire_engine::JsonEngine` rather than in the
WASM crate, so it is covered by ordinary `cargo test`. `insulaire-wasm` is a
pass-through with no logic of its own.

**The method list is not in this ADR.** It has grown from ten methods to over
fifty, and a list copied here would be wrong within a week. `docs/wasm-api.md` is
the reference, parameter by parameter; this decision governs the *shape* every
addition to it must take.

It is, however, written down exactly once. `crates/engine/seam.json` declares
each method — name, parameters, return shape and documentation, or, for a
content kind, one row that expands into the methods that kind has — and
`scripts/generate-seam.mjs` renders the four copies that used to be kept by
hand: `JsonEngine`, the `#[wasm_bindgen]` methods, `RawInsulaireEngine` and the
reference's method table. `EngineService` stays hand-written, because it returns
typed values and marshals its arguments, but the generator fails if it does not
reach every declared method. That is this decision's consequence list being
acted on, not a change to it: the shape rules above are what a declaration may
express.

## Consequences

Positive:
- rendering a 2048x2048 world costs one 4 MiB transfer, not four million calls;
- the engine's internals can change freely as long as the DTOs hold;
- the whole boundary is testable natively, without a browser;
- the UI cannot disagree with the rules it displays, because it does not
  implement them;
- a new content kind arrives as a predictable set of methods rather than as a
  new shape of boundary — and arrives by declaration: one `ContentKind` and one
  row in the seam, with nothing hand-written per kind in the registry, the
  facade, the string contract or the bindings.

Negative:
- every new piece of information the UI needs is a deliberate DTO change;
- JSON string payloads are parsed twice. Against snapshot sizes of a few hundred
  bytes this is irrelevant; if it ever matters, the change is local to
  `crates/engine/src/json.rs` and `crates/wasm/src/lib.rs`;
- the surface is wide and still grows with every content kind, so
  `docs/wasm-api.md` is load-bearing documentation rather than a convenience.
  What no longer grows with it is the amount of code behind the surface;
- the generic methods are read with a turbofish — `load::<kinds::World>(json)` —
  which is more to type at a call site than `load_world(json)` was, and is the
  price of the kind being a value the compiler checks rather than a name.

## Rule

Angular may not compute a rules answer that the engine could give it. If the UI
needs to know whether something is allowed, the engine must expose it.

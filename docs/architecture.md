# Target Architecture

```text
                     ┌──────────────────────────┐
                     │ Angular Application      │
                     │                          │
                     │ Game UI                  │
                     │ Character Creator        │
                     │ Deck Builder             │
                     │ World Editor             │
                     │ Scenario Editor          │
                     └────────────┬─────────────┘
                                  │
                             Engine API
                                  │
                     ┌────────────▼─────────────┐
                     │ Rust Game Engine / WASM  │
                     │                          │
                     │ GameState                │
                     │ Authored World           │
                     │ Tick Simulation          │
                     │ Scenario Runtime         │
                     │ Events / Triggers        │
                     │ AI / Pathfinding         │
                     │ Combat / Cards           │
                     │ Deterministic RNG        │
                     └────────────┬─────────────┘
                                  │
                           Render State
                                  │
                     ┌────────────▼─────────────┐
                     │ Canvas / WebGL Renderer  │
                     └──────────────────────────┘
```

The editor uses the same content models as the runtime, but should not embed simulation rules in Angular.

## Suggested repository

```text
/
├── apps/
│   ├── web/                 # Angular runtime
│   └── editor/              # Angular editor, if split later
├── crates/
│   ├── engine/              # engine facade
│   ├── world/               # map, hexes, entities
│   ├── scenario/            # acts, triggers, events
│   ├── combat/              # deck/cards/effects
│   ├── simulation/          # ticks and systems
│   └── wasm/                # WASM bindings
├── content/
│   ├── worlds/
│   ├── scenarios/
│   ├── assets/
│   ├── tilesets/
│   └── cards/
├── docs/
│   └── adr/
└── CLAUDE.md
```

A monorepo is recommended initially.

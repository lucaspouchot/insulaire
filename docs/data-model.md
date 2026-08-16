# Conceptual Data Model

## WorldDefinition

An authored world contains at minimum:

- `id`
- `version`
- `width`
- `height`
- `orientation`
- `layers`
- `tiles`
- `locations`
- `entities`
- `scenarioId`

The map is not derived from a seed.

## TileDefinition

A terrain tile describes:
- identity
- sprite/tile source
- tags
- movement cost
- gameplay properties
- render layer

## EntityDefinition

A placed entity may contain:
- hex position
- template
- tags
- persistent properties
- behavior reference
- asset reference

## ScenarioDefinition

The scenario contains:
- acts
- phases
- objectives
- flags
- timers
- triggers
- events
- consequences

References should use stable IDs rather than fragile array indices or positions.

## Runtime State

Definitions are immutable during a play session. The runtime maintains mutable state:

```text
GameState
├── tick
├── player
├── worldState
├── entityState
├── scenarioState
├── combatState?
└── rngState
```

Keep `Definition` and `State` strictly separate.

## Why

This supports:
- multiple playthroughs using the same world
- compact saves
- editor-driven content
- automated validation
- future content migrations

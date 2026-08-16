# ADR-0005 — Make Scenario Progression Data-Driven

## Status
Accepted

## Context

The world contains an authored scenario with acts, objectives, events, countdowns and major scripted moments.

## Decision

Scenario progression is implemented as a data-driven state machine.

Core concepts:
- `Act`
- `Objective`
- `Flag`
- `Timer`
- `Trigger`
- `Event`
- `Consequence`

Conceptual example:

```text
Trigger:
    tick >= 500
    AND flag "ritual_started" == true

=> Event:
    "ritual_complete"

=> Consequences:
    spawn boss
    set flag "boss_awake"
    advance act
    start event "guardian_arrives"
```

Scenario-specific rules must not be hard-coded into Rust.

## Consequences

The engine becomes a controlled rules interpreter.

An unrestricted general-purpose scripting language is intentionally out of scope initially.

# ADR-0017 — Author Map Links as Content; Resolve Them in the Engine

## Status
Accepted

## Context

A world was a single map. The authored schema had no way to say "this hex is a
door", and `GameState` was built once from one `WorldDefinition` and never
changed map. Any game with interiors — a house on the valley map, a cave, a
ship — needed a second map and a way to get there.

Three designs were considered.

**One giant map with regions** was rejected: it forces every interior to share
one coordinate space, one tile set and one projection, and it makes the packed
terrain buffer as large as the sum of everything the game contains, however
little of it is on screen (`CLAUDE.md`, "Performance").

**A scenario trigger** — "when the player reaches [3, 10], change map" — was
rejected for now because the scenario runtime (ADR-0005) does not exist yet, and
because a door is a property of the *place*, not of the plot. A scenario should
be able to lock a door; it should not have to own its existence.

**Engine-side link following inside the tick** was rejected as a layering
break. `insulaire-simulation` deliberately holds one `Arc<WorldGrid>` and knows
nothing about the content registry; letting the tick pipeline fetch another
world would give the rules crate a dependency on content loading, which
ADR-0001 and ADR-0013 exist to prevent.

A fourth question was who the traveller is. Carrying the player entity across
maps means a destination map has no player of its own and cannot be played or
tested alone, and every map's validity would then depend on how it is entered.

## Decision

**A link is authored content.** `WorldDefinition.links` is a list of
`MapLinkDefinition`:

```json
{ "id": "link_refuge_door", "at": [3, 10], "targetWorld": "demo_refuge",
  "targetAt": [3, 4], "name": "Refuge", "tags": ["door"] }
```

`trigger` defaults to `enter` and is the only value implemented; `interact` is
reserved and rejected by validation, as `HexOrientation::Flat` is.

**A link fires on entry, not on presence.** Phase 2 of the tick reports the hex
the player moved *into*, and phase 3 fires the link on that hex. Waiting on a
door does nothing, and arriving on one — which is exactly what the door on the
other side does — cannot bounce the session between two maps.

**The tick reports; the host resolves.** `tick::apply` returns an
`ActionOutcome.transition: Option<PendingTransition>` naming the target, and
emits `linkTriggered`. `Engine::dispatch` then looks the world up in its
registry and calls `GameState::enter_world`, emitting `worldEntered`. Phases 4
to 6 still run before the swap, so the pipeline order of ADR-0004 is unchanged
whether or not a link is involved. A target that cannot be resolved emits
`linkUnresolved` and leaves the session where it was — a broken door must not
end a session.

**Every map keeps its own player.** `enter_world` instantiates the target map
exactly as `create` would, then carries the *session* across: the tick counter,
the RNG stream, and the arrival position. The player entity is the one the
target map authors, so every map stays independently valid, playable and
testable, and `world.missingPlayer` stays an error.

**Validation is split by what a file can know.** Bounds, duplicate ids,
duplicate cells, impassable cells and unsupported triggers are checked per
world. The target is checked by `validate_project_links` over every loaded
world (`link.unknownTargetWorld`, `link.targetOutOfBounds`,
`link.targetImpassable`, `link.targetOccupied`), exposed as `validateLinks()`.
A world with an outbound link is therefore valid on its own, which is what lets
a map be authored before its neighbour exists.

## Consequences

Positive:
- interiors, hubs and multi-map games are content, not code: no engine change is
  needed to add a door;
- each map keeps a small packed buffer, so viewport cost tracks the visible map;
- the simulation crate still knows nothing about content loading;
- determinism survives a map change: one seed, one RNG stream, one tick counter.

Negative:
- adding `links` widens the world schema. It is an optional field with a serde
  default, so old files still load and `WORLD_SCHEMA_VERSION` stays 1 — but the
  canonical serialiser now writes a `"links": []` line into every world file;
- a link's target cannot be validated from a single file, so the editor needs
  the whole project loaded to give a verdict. Authoring one map in isolation
  therefore shows fewer errors than the runtime will;
- the player entity is per map, so anything the player accumulates — health,
  inventory, a deck — will *not* survive a door until `enter_world` is taught to
  carry it. That is deliberate: it is one function, and the seam is named;
- monsters on the map being left still take their turn in the same tick, and
  that state is then discarded. Cheap and invisible today; it would matter if
  maps ever had to persist between visits;
- the arriving player takes its cell unconditionally. Validation rejects a door
  arriving on an *authored* entity (`link.targetOccupied`), but a monster that
  has walked onto that cell during play will share a hex with the arriving
  player for as long as it stays there. Resolving it properly means deciding a
  rule — push, block, or swap — and that is a rules decision, not a link one.

## Rule

A map link's target is resolved by `validate_project_links` and followed by
`Engine::dispatch` — the simulation crate may name a target world but must never
load one.

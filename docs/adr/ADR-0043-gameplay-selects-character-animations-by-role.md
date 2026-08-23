# ADR-0043 — Gameplay Selects Character Animations by Role

## Status
Accepted. Extended by `docs/adr/ADR-0044-map-entity-presentation.md`, which
scales characters in tile units and interpolates movement events.

## Context

Character definitions already describe sprites, customisations and named
animations, but gameplay entities are still coloured discs with glyphs. In
particular the player is an `@`, exactly the gap recorded by
`docs/adr/ADR-0028-character-definitions.md`: the authored character pipeline
exists, but nothing on the map wears one.

A runtime cannot safely infer that an animation named `idle`, `walk` or
`walking_left` has a particular gameplay meaning. Ids are author-owned, and a
name-based convention would be invisible to validation and awkward to expose in
the editor. Requiring six walk cycles would be equally wrong: left-facing and
right-facing art are enough for the common case, while a character with
direction-specific silhouettes must still be able to author all six.

## Decision

An animation may declare one optional gameplay `role`: `idle`, `moveLeft`,
`moveRight`, `moveEast`, `moveNorthEast`, `moveNorthWest`, `moveWest`,
`moveSouthWest` or `moveSouthEast`. A role may be claimed only once inside a
character definition. Animation ids remain arbitrary and continue to be the
way editors and scripted previews request an exact animation.

Gameplay asks the Rust character resolver for a role rather than guessing an
animation id. An exact hex-direction role wins. When it is absent, east,
north-east and south-east fall back to `moveRight`; west, north-west and
south-west fall back to `moveLeft`. An absent `idle` or movement role resolves
to the rest pose, so a still character remains valid.

Movement events choose the transient movement role; after one pass of that
animation, the character returns to `idle`. The event remains the presentation
seam: animation time is not simulation state and does not advance a tick.

The map renderer draws the same `ResolvedCharacter` as the resource editor and
character-creation preview. It may place that resolved canvas at an entity's
ground point, but it never selects layers, variants, tints or animation ids.

## Consequences

Positive:
- two authored walk cycles cover every hex direction by default;
- any of the six directions can override that fallback with distinct art;
- roles are visible in the editor and invalid duplicates are caught before a
  file is saved;
- runtime, preview and tests continue to use the one Rust character resolver;
- animation playback remains presentation-only and does not pollute
  deterministic `GameState`.

Negative:
- one animation can claim only one role; sharing a cycle across several exact
  roles requires small mirror/reference animations;
- the player-facing canvas redraws while an idle animation runs, adding a
  bounded per-frame rendering cost;
- choosing which character and customisation a gameplay entity wears is only
  wired for the player in this change; generic NPC appearance remains future
  work.

## Rule

Gameplay selects authored character animations by validated role, with exact
hex directions overriding the left/right fallback; it never infers meaning from
an animation id.

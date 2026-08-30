# ADR-0029 — Character Creation Is a Generic Authored Workflow

## Status
Accepted

## Context

The project needs a player-facing sequence that may ask for a race, a gender,
hair, body proportions, eye colour and game-specific statistics. Those words
must not become engine fields: another game may have origins instead of races,
body plans instead of genders, or represent the same decision with a different
character JSON rather than a parameter on one definition.

Creation also cannot mirror a character definition's parameter list one for
one. The resource editor may expose armour, a cape or quest-unlocked hairstyles
that do not belong at creation; conversely, a created player's name, age, health
or corruption are state rather than sprite-selection parameters.

Putting this logic in an Angular form would contradict
`docs/adr/ADR-0012-shared-content-validation.md`: the editor could then author a
workflow the runtime cannot validate. Adding race/gender branches to
`CharacterDefinition` would contradict the category-neutral pipeline of
`docs/adr/ADR-0024-character-definitions.md`.

## Decision

A project may reference one versioned `CharacterCreationDefinition`. It owns
three independent ordered lists:

- `choices` use the shared `ControlDefinition` vocabulary. Each binds either to
  the selected character definition or to one named character parameter. A
  creation select authors its own options, so it can expose a strict subset of
  what the resource permits; direct colour and numeric controls forward their
  value dynamically.
- `characteristics` also use the control vocabulary, plus `nullable`. Missing
  numeric bounds mean infinity in that direction. These values belong to the
  created player rather than to appearance.
- `screens` contain ordered text, choice, characteristic, preview and summary
  blocks. A preview may name a character animation and temporary generic
  parameter overrides, so armour can be shown without making equipment a
  creation choice.

Choice ids, characteristic ids and parameter ids are author-owned strings.
There is no reserved `race`, `gender`, `hair`, `hp` or `mana`. Resolution in
Rust produces only `{ character, choices, parameters, characteristics }` and
never interprets a key.

The editor is its own `/editor/creation` module. It validates through the Rust
engine, resolves previews through the same character resolver as the resource
editor, and writes the declaration as content. This does not fold into the
resource editor: resources define every appearance a game can draw; creation
defines which initial choices a player is offered and how they are presented.

## Consequences

Positive:
- one schema represents race, gender and arbitrary game-specific concepts
  without teaching the engine any of them;
- creation choices are checked against character definitions while remaining a
  deliberate subset of their parameters;
- equipment and unlockable appearances stay available to later systems without
  leaking into the initial form;
- characteristics cover bounded, half-bounded, unbounded, boolean, enum,
  nullable and free-text values without a fixed stat list;
- workflow screens and the live preview are data, so games do not fork Angular
  to change their creation sequence.

Negative:
- cross-file validation requires character definitions to be loaded before the
  creation declaration;
- a condition may only refer backwards in author order, making resolution a
  deterministic single pass but excluding cyclic or computed dependencies;
- the first version defines authoring, validation and resolution; carrying the
  result in `GameState` and saves remains a separate runtime decision;
- preview parameter overrides are generic and therefore cannot promise that
  every candidate character renders the same equipment or animation.

## Rule

No engine or host code branches on the semantic name of a character-creation
choice or characteristic; it may only resolve its declared binding and control
type.

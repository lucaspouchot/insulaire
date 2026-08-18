# ADR-0025 — Engine Settings Belong to the Shell, Game Settings Are Content

## Status
Accepted

## Context

A delivered game needs a settings screen: volumes, interface scale, language,
window size — and whatever knobs the *game* wants, which for this project means
difficulty, starting population, which factions are in play, and things nobody
has thought of yet.

Those two lists look alike on screen and are nothing alike underneath.

"Master volume" is something the **application** implements: there is code that
multiplies a gain, and no content file can invent it. "Starting population" is
something the **game** means: the engine must not know what a population is, or
`CLAUDE.md`'s rule — no scenario-specific behaviour in the engine — is already
broken.

Three shapes were considered.

**Everything in content**, including volumes: a game would then have to declare
the settings the application needs before the application works at all, and a
project that forgot one would ship a build with no way to turn the music down.

**Everything in code**, game settings included: every game would need a fork of
this repository to add a difficulty toggle. That is the failure this whole
engine exists to avoid.

**Two vocabularies, one for each**: two renderers, two validators, two things an
author has to learn, and two places for a slider bug to live.

## Decision

**Two owners, one vocabulary.**

`ControlDefinition` — id, label key, control kind (`toggle`, `checkbox`,
`select`, `multiSelect`, `slider`, `number`, `text`, `color`), default, options,
bounds, scope, and an optional `showIf` — describes *both* kinds of setting. One
component (`control-field`) renders it, so a game's settings screen looks like
the application's because it is the same screen.

**The application's settings live in TypeScript**
(`app/settings/engine-settings.schema.ts`): interface scale, fullscreen and
window size (desktop only), language, text speed, three volumes, and the seed a
new game starts from. They are declared with the same `ControlDefinition` type
but they are *not* content, because the engine has no business knowing that a
screen has a size (ADR-0001).

**The game's settings are content**: `content/settings.json`, referenced by the
manifest, parsed and validated in Rust like every other content file (ADR-0015).
The engine validates the declaration — unique ids, a default its own control
accepts, coherent bounds, a `showIf` pointing at a field that exists — and
resolves values against it. It never interprets one.

**`resolve` is the single rule for "what is this value, really".** Defaults
filled, unknown keys dropped, numbers clamped, options checked. The settings
screen and `createGame` both go through it, so what a player sees and what the
game is created with cannot disagree.

**Game settings cross the boundary once**: `createGame(worldId, seed, settings)`
— a breaking change to the boundary, taken now because pre-1.0 is when to take
it (`CLAUDE.md`). The resolved values are echoed in every `GameSnapshot`, so a
scenario will read them from the state it already receives.

They are held by the `Engine`, **not** by `GameState`, because no rule reads one
yet. The day a scenario needs a setting, they move into the state — and that is
also when a save has to carry them (ADR-0010).

**`scope` says when a setting may change.** `session` applies immediately — a
volume moves under the player's hand. `newGame` is frozen once a game exists and
is shown **locked with a reason** rather than hidden: the value is part of the
game in progress, and a player looking for it deserves to find it.

**`showIf` is the whole conditional vocabulary**: one field, one value. Anything
richer is a rules language, which is a non-goal.

## Consequences

Positive:
- a game declares a difficulty setting and gets a working screen for it — no
  code, no fork, translated like everything else (ADR-0023);
- the application's settings work before any project loads, which is what the
  editor and a bare checkout need;
- one implementation of "clamp, default, check the options", in Rust, for the
  screen and the engine alike;
- the boundary carries the game's settings and nothing else: no volume ever
  reaches the simulation.

Negative:
- `createGame` gained a parameter, so every host and every test moved;
- the control vocabulary is fixed: a game wanting a two-handle range slider or a
  key binding needs a new control kind here, which is a code change and an ADR;
- settings live in `localStorage` and are therefore per browser profile, not per
  player — and a delivered executable shares one profile per machine;
- game settings are resolved but **not yet read by anything**: until a scenario
  uses one, a player can set a difficulty that changes nothing;
- the application's schema is duplicated conceptually in two languages — the
  type in Rust, the values in TypeScript — and only review keeps the two lists
  of control kinds in step.

## Rule

A setting the *application* implements is declared in
`engine-settings.schema.ts`; a setting the *game* means is declared in its
content. The engine validates and resolves both shapes but interprets neither,
and only the game's settings cross `createGame`.

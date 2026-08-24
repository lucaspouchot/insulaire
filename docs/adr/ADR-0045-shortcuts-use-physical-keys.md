# ADR-0045 — Shortcuts Use Physical Keys

## Status
Accepted

## Context

Player commands need keyboard shortcuts that keep the same spatial arrangement
on AZERTY, QWERTY and QWERTZ keyboards. Storing the printed character would put
the north-west command on `Z` everywhere, which moves it from the top row on
AZERTY to the bottom row on QWERTY. Hard-coding one binding per named layout is
also incomplete: layouts and user variants are more numerous than a maintained
list can be.

ADR-0025 says that application settings live in TypeScript, game settings are
content, and both use `ControlDefinition`. It also names a key binding as the
case that requires a new control kind and an ADR. The ownership split must stay
intact: a game may name its own input action, but it may not replace the
application's universal movement actions.

## Decision

`keyBinding` extends the shared settings control vocabulary. Its value is one
non-modifier `KeyboardEvent.code`: a physical key position, not the character
reported by `KeyboardEvent.key`. A binding is one key rather than a chord;
Escape is reserved to cancel capture, and its scope is always `session` so it
can be rebound during play.

The application declares universal actions in `engine-settings.schema.ts`. The
six movement defaults are the physical positions `KeyW`, `KeyE`, `KeyA`,
`KeyD`, `KeyZ`, `KeyX`; they therefore read `Z`, `E`, `Q`, `D`, `W`, `X` on a
French AZERTY keyboard while preserving the same six-key shape elsewhere.

Games declare additional `keyBinding` fields in `settings.json`, through the
same editor as their other settings. The field id is the game-owned semantic
action id. The generic shell captures, displays, persists and resolves the
binding but does not invent what that game action does, following ADR-0025.

The settings screen asks the browser's keyboard layout map for the printed
label when it is available and remembers `event.key` when the player captures a
binding. The stored value remains the physical code. Rebinding onto an occupied
key swaps the two values, keeping every action reachable without a conflict
dialogue.

## Consequences

Positive:
- spatial controls work out of the box across the common Latin keyboard
  layouts without identifying the layout;
- application actions and game-authored actions share one capture control, one
  persistent value store and one editor vocabulary;
- rebinding is independent of the language in which the UI is displayed.

Negative:
- a binding follows the physical key when the operating-system layout changes;
  this is intentional for spatial controls but can surprise a player who thinks
  only in printed characters;
- the Keyboard Layout Map API is not universal, so an untouched binding may use
  a code-derived fallback label until the player presses it;
- modifier chords are outside this model and require a future schema decision
  rather than being encoded into strings informally.

## Rule

Persist keyboard shortcuts as modifier-free `KeyboardEvent.code` values; use
`KeyboardEvent.key` only to label them.

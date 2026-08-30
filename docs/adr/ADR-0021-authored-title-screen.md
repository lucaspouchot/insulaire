# ADR-0021 — The Client Opens on an Authored Title Screen

## Status
Accepted

## Context

A delivered build opened on `/play` and dropped the player straight onto a map.
That is a development shortcut, not a game: there is nowhere to change a
setting, nothing to load, no way to leave, and nothing that says what the player
has just launched. ADR-0015 fixed *what* the client ships; it said nothing about
what the client shows first.

The screen it should show is also the most game-specific one there is. Its
background, its music, its logo, the order of its buttons and the words on them
are the game's identity, and this repository is an **engine** — none of that can
be written into a template here, or a second game would need a fork.

But the *actions* are not game-specific. Starting a game, resuming one, opening
the settings, leaving — those are things the application implements, and a
content file cannot invent a new one without code to perform it.

**A hard-coded menu with an authored skin** (colours and images only) was
rejected: label text and button order are exactly what differs between games,
and the moment one needs a Credits entry the engine changes.

**A scriptable menu** — content describing behaviour — is the other extreme, and
runs straight into `CLAUDE.md`'s "unrestricted scripting language" non-goal.

## Decision

**The menu is content; the actions are a closed set.**
`TitleScreenDefinition` (`crates/world/src/title_screen.rs`,
`TITLE_SCREEN_SCHEMA_VERSION = 1`) authors the background, an optional logo, an
optional splash, optional music, the theme colours, the layout and the buttons.
Each button names a `TitleAction` — `newGame | continue | settings | credits |
quit` — and carries a `labelKey`, because text is never written where it is
displayed (ADR-0020).

**The project points at it.** `ProjectDefinition.titleScreen` is a `ContentRef`
like a world or a tile set, and `loadProject` refuses a manifest whose title
screen is not loaded — the same rule that already covers worlds. A project
without one is legitimate: the application falls back to a plain menu carrying
the same actions, which is what a bare project and the editor both want.

**Both builds open on it.** `''` redirects to `/title` in `app.routes.ts` *and*
`app.routes.deliver.ts`: the player's first screen should be the one developers
look at too, or it rots.

**The application bar is hidden there.** The title screen takes the whole
window; a navigation bar and an engine badge across the top of it would be
development tooling leaking into the product. Every other screen keeps the bar,
which is also how a developer leaves the title screen.

**What the build and the session make possible is decided in code.** `quit` is
dropped outside the desktop shell, because a browser tab has no window to close;
`continue` renders **disabled with a reason** until a save exists, rather than
disappearing — a menu that changes shape depending on hidden state is worse than
one that says why a choice is unavailable.

**Music starts on the first gesture.** Browsers refuse `play()` until the
visitor has interacted, and a refused promise is the normal first outcome.
`AudioService` remembers the track and starts it when the splash is dismissed —
which is the gesture — so nothing depends on autoplay being allowed.

**Asset paths are validated, not resolved.** The engine checks that a path is
relative, has no parent segment and is not a URL; whether the file exists is the
host's business, because no build of the engine can see a disk. Keys, by
contrast, *are* resolved: `loadProject` reports a `labelKey` no language defines,
so a blank button fails before shipping rather than in front of a player.

## Consequences

Positive:
- a game's first screen is authored, translated and validated like the rest of
  its content — no fork, no rebuild, no code;
- a delivered client can be left (Quit), configured (Settings) and started, which
  is the minimum a shipped game owes a player;
- the closed action set keeps the engine free of scenario behaviour while still
  letting an author build the menu they want;
- the same screen is what development sees, so it cannot quietly break;
- the fallback menu means a bare project — and every test — still has a working
  title screen.

Negative:
- a new action is a code change *and* an ADR, which is the point but is also
  friction for a game that wants "Continue where I left off" spelled differently;
- the theme is a handful of CSS custom properties, not a stylesheet: a game
  wanting a radically different menu will outgrow it;
- `continue` is permanently disabled until saves exist (ADR-0007), so the button
  currently advertises something the build cannot do;
- the splash is an overlay on one route rather than its own screen, so it cannot
  be revisited or chained — a second splash needs a different design;
- hiding the application bar on `/title` is a route-name check in the shell, and
  a future full-screen screen has to remember to add itself.

## Rule

A title screen button may only name an action the application already
implements. Anything a game wants to *say* is a key, and anything it wants to
*show* is a content path — never a literal in a template.

# ADR-0023 — The Session Outlives the Route, and the Title Screen Ends It

## Status
Accepted

## Context

`PlayPage.ngOnDestroy` called `endGame()`. Leaving `/play` — for the settings,
for the editor, for anywhere — silently destroyed the game, and coming back
created a new one from the same seed. Nothing said so.

That is invisible until something needs to know whether a game is running, and
three things now do at once:

- the settings screen shows `newGame` settings **locked while a game runs**
  (ADR-0022). Opening it from `/play` ended the game, so nothing was ever
  locked and the whole scope mechanism was dead on the one path a player takes;
- a player opening the settings mid-game and pressing *Back* expects the game
  to still be there;
- the application bar's *Title* link is where a game is actually abandoned, and
  abandoning one deserves a question — but only if there is one to abandon.

Underneath it is a question about ownership. ADR-0001 puts `GameState` in the
Rust engine, not in Angular components. A component that ends the session when
its canvas is disposed is a component behaving as though it owned it.

Two shapes were considered.

**Keep the game inside the route** and forbid leaving it — a modal settings
dialog drawn over the play screen, no navigation away. That is a second settings
screen to build and keep in step with the first, and it puts the editor out of
reach mid-game for no reason.

**Let the route own the session and warn on the way out**, via a
`CanDeactivate` guard on `/play`. But then *every* departure is a loss to
confirm, including opening the settings — which is precisely the departure that
should cost nothing.

## Decision

**The engine owns the session; the route only draws it.**

`PlayPage` no longer ends the game when it is destroyed. Arriving at `/play`
asks the engine whether a game exists: if one does it is **resumed** — the
snapshot is read back and drawn, no tick spent, no RNG drawn — and otherwise a
new one is created. Resuming logs `Resumed "<world>" at tick <n>`, so it is
visible in the event stream rather than inferred.

**A game ends where a player says so**, and there are exactly three such places:
*Restart* on the play screen, *New game* on the title screen, and the
application bar's **Title** entry, which asks first. `EngineService.endGame()`
is called at those three points and nowhere else.

**`EngineService.hasGame` is a signal**, mirrored from the engine on either side
of `createGame` and `endGame` and read back from it there. The shell reacts to
it — the settings screen locks its `newGame` fields, the bar decides whether to
ask — and a method call into WASM cannot be reacted to.

**The title screen and the settings screen drop the application bar.** Both are
screens a *player* opens; a navigation bar and an engine badge across the top of
them is development tooling leaking into the product (ADR-0021). The settings
screen therefore carries its own way back, and `?from=` — set by whoever opened
it, validated to be an in-application path — says where that leads.

**Whoever runs `resetContent()` puts the whole manifest back.** `loadProject`
validates the manifest against what is loaded, so the languages, the title
screen and the game's settings are re-registered with the maps. Each is held by
a service that keeps the file's own bytes and can register them again —
`I18nService.register()`, `TitleScreenService.register()`,
`SettingsService.register()` — and an editor that saves one calls `adopt()`, so
what a reset restores is what was last written.

**The splash belongs to the launch, not to the route.** It plays once per page
load, which is what a delivered executable's launch is, and the title screen
withholds its menu until it knows whether a splash is coming — otherwise the
menu paints first and the splash covers it, which reads as a flash of the wrong
screen.

## Consequences

Positive:
- `scope: newGame` finally does something on the path a player actually walks;
- opening the settings or the editor mid-game costs nothing, and going back to
  the title costs exactly one confirmation;
- one statement of what re-registration means, instead of each caller
  remembering a different subset of it;
- the resume path exercises `snapshot()` on every navigation, so a divergence
  between what the engine holds and what the UI draws surfaces immediately.

Negative:
- a game now survives until something ends it, so a developer hopping between
  screens keeps a session they may have forgotten about — *Restart* is the way
  out, and the tick badge says it is there;
- the confirmation is the only modal in the application, and it exists for a
  loss that saves would make unnecessary (ADR-0007): when saves land, this
  dialog gains a third answer and this decision needs revisiting;
- `hasGame` is a mirror, so a future path that ends a game without going through
  `EngineService` would desynchronise the shell;
- the splash-once flag is module state keyed to a page load. In the desktop
  shell that is exactly one launch; in a browser tab that is a refresh.

## Rule

A game ends only where a player asks for it. Anything that navigates away from
`/play` leaves the session alone, and anything that calls `resetContent()`
re-registers the languages, the title screen and the settings along with the
maps.

# ADR-0016 — The Editor Is an Angular Application of Registered Modules

## Status
Accepted

## Context

The authored world needs a level editor, similar in spirit to RPG Maker but on a
hexagonal grid. Building it as a separate tool — in another language, against
its own copy of the content model — is how an editor and a runtime come to
disagree about what a valid world is. Building it inside the application means
one shell, one renderer and one engine boundary, already written.

The editor will not stay one screen. Maps, characters, assets, languages, the
title screen, settings, character creation and scenarios are each a different
domain with a different document model. Growing the map editor into a component
that also edits scenarios produces the screen nobody dares to change.

**A separate Angular app per editor** repeats the shell, the content services
and the engine boundary once per domain. **Ad-hoc routes added under `/editor`**
works, and then the list of what the editor contains exists in three places —
the routes, the navigation and whatever documentation is written — which drift.

## Decision

**The editor is Angular, and reuses the runtime's content definitions.** It
exports validated runtime definitions and implements no game rule of its own;
any check that decides whether content is loadable belongs to the engine
(ADR-0012). Editor-specific models may be richer than runtime models where an
editing workflow needs it — an open document is not a saved file.

**`/editor` is a shell with one lazily-loaded child route per module**, and the
modules are declared once in `editor-modules.ts`:

```text
/editor/map        MapEditorPage            available
/editor/asset      AssetEditorPage          available   (ADR-0028)
/editor/title      TitleEditorPage          available   (ADR-0021)
/editor/locale     LocaleEditorPage         available   (ADR-0020)
/editor/settings   SettingsEditorPage       available   (ADR-0022)
/editor/creation   CreationEditorPage       available   (ADR-0029)
/editor/scenario   PlannedModulePage        planned     (ADR-0004)
```

`EDITOR_MODULES` is the single source: `editor.routes.ts` builds the routes from
it and the shell builds its tab bar from it. A module marked `planned` routes to
one shared placeholder page that reads its description from the same entry, so a
future module is one entry now and one component later.

**A module is a domain, not a screen.** The registry may shrink as well as grow:
`character` was a module until the asset editor absorbed it as a category
(ADR-0028), and that is the same property — one entry left, nothing else moved.

**Modules do not talk to each other.** Shared state belongs in a service — the
project itself in the four modules under `app/project/` (`ProjectManifest`,
`WorldLibrary`, `TileSetLibrary`, `WriteLedger`), each injected by the modules
that need it; shared rules belong in Rust.

## Consequences

Positive:
- adding an editor is a registry entry plus a component — no separate route
  list, tab bar and document to keep in step;
- each module is lazily loaded, so the map editor's code does not travel with a
  scenario editor nobody has written;
- the whole editor hangs off one route file, which is what lets the client build
  drop it wholesale (ADR-0015);
- what the tool will become is visible in the UI rather than in a backlog.

Negative:
- routes are derived rather than written, so a typo in a module id fails at
  navigation time rather than at compile time;
- placeholder pages ship in the dev build and are dead weight until implemented;
- the registry says nothing about a module's content model, so nothing here
  stops a future module inventing its own document conventions.

## Rule

Every editor screen is registered in `editor-modules.ts` and reached through
`/editor/<id>`; no editor route may be declared anywhere else. The editor never
implements a second version of a game rule.

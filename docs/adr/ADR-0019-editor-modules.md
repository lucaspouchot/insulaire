# ADR-0019 — Structure the Editor as Registered Modules Behind One Shell

## Status
Accepted

## Context

ADR-0008 decided that the editor is an Angular application sharing the runtime's
content definitions. It said nothing about the editor's *internal* shape, and
the MVP had exactly one screen — `/editor` was the map editor.

The tool will not stay that way. Characters (entity templates), assets (tile
sets, sprites, visual ids) and scenarios (ADR-0005) all need editing, and each
one is a different domain with a different document model. Growing the map
editor into a component that also edits scenarios would produce exactly the kind
of screen nobody dares to change.

Two alternatives were considered. **A separate Angular app per editor** repeats
the shell, the content services and the engine boundary four times. **Ad-hoc
routes added under `/editor` as needed** works, but the list of what the editor
contains then exists in three places — the routes, the navigation, and whatever
documentation is written — and they drift.

## Decision

**`/editor` is a shell with one lazily-loaded child route per module**, and the
modules are declared once in `editor-modules.ts`:

```text
/editor/map        MapEditorPage        available
/editor/title      TitleEditorPage      available   (ADR-0024)
/editor/locale     LocaleEditorPage     available   (ADR-0023)
/editor/character  PlannedModulePage    planned
/editor/asset      PlannedModulePage    planned
/editor/scenario   PlannedModulePage    planned
```

Two of those were planned entries that became components, which is the shape
this ADR predicted: the title screen editor and the language editor cost one
registry entry and one component each, and nothing else moved.

`EDITOR_MODULES` is the single source: `editor.routes.ts` builds the routes from
it and the shell builds its tab bar from it. A module marked `planned` routes to
one shared placeholder page that reads its description and its planned
responsibilities from the same entry — so a future module is one entry now and
one component later, and the editor's intended shape is visible in the UI
instead of living in a backlog.

Modules do not talk to each other. Shared state belongs in a service
(`ProjectStoreService` today); shared *rules* belong in Rust, which ADR-0015
already requires.

## Consequences

Positive:
- adding an editor is a registry entry plus a component: no route list, tab bar
  and doc to update separately;
- each module is lazily loaded, so the map editor's code does not travel with a
  scenario editor that has not been written;
- the whole editor still hangs off one route file, which is what lets the client
  build drop it wholesale (ADR-0018);
- users can see what the tool will become without a hidden feature flag.

Negative:
- one more indirection: the routes are derived rather than written out, so a
  typo in a module id fails at navigation time rather than at compile time;
- placeholder pages are shipped in the dev build and are, by definition, dead
  weight until implemented;
- the registry says nothing about a module's *content model*. Nothing here
  prevents a future module from inventing its own document conventions, which is
  a discipline problem the shell cannot solve.

## Rule

Every editor screen is registered in `editor-modules.ts` and reached through
`/editor/<id>`; no editor route may be declared anywhere else.

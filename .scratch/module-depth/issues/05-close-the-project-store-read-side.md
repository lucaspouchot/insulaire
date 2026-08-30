# 05 — Close the project store's read side

Status: needs-triage
Strength: strong
Blocked by: —

## Problem

`apps/web/src/app/services/project-store.service.ts` is 1,029 lines and **55
public members** — 7 signals plus 48 methods — carrying six unrelated concerns
under one interface:

1. world documents — `requireDocument`, `addWorld`, `removeWorld`, `renameWorld`,
   `importDefinition`, `selectWorld`, `worldChoices`, …
2. tile sets — `requireTileSet`, `requireTileSetFor`, `tileSetDefinitions`,
   `replaceTileSet`, `tileSetPath`
3. zones — `zones`, `defaultZoneId`, `addZone`, `removeZone`, `setZone`
4. locale files — `localeFiles`, `setLocaleFiles`, `declareLocaleFile`
5. manifest bookkeeping — `declareCharacter` / `undeclareCharacter` /
   `characterPath`, and the same trio for decoration and object
6. write tracking — `dirty`, `manifestNeedsWriting`, `hasUnwrittenChanges`,
   `worldNeedsWriting`, `changedWorldIds`, `orphanedWorlds`, `markWorldWritten`,
   `markWorldDeleted`, `markManifestWritten`, `refreshDirty`

A caller that wants "is anything unsaved" learns a module covering five content
kinds and manifest write-tracking. There is no seam between the six — only
comments and blank lines.

### The manifest is encapsulated for writing and open for reading

Writes go through the interface (`declareCharacter`, `characterPath`,
`undeclareCharacter` — lines 642–795). Reads go around it. Ten modules, twenty
call sites, each independently knowing `ProjectDefinition`'s field names:

```
character-workspace.ts:376,783          store.project()?.characters ?? []
decoration-workspace.ts:274,432         store.project()?.decorations ?? []
object-workspace.ts:162,240             store.project()?.objects ?? []
character-library.service.ts:25         store.project()?.characters ?? []
decoration-library.service.ts:31        store.project()?.decorations ?? []
object-library.service.ts:27            store.project()?.objects ?? []
title-editor-page.ts:75,99              store.project()?.titleScreen…
settings-editor-page.ts:94,103,106,174  store.project()?.settings…
character-creation-editor-page.ts:102,208  store.project()?.characterCreation…
locale-authoring.service.ts:65          store.project()?.locales?.languages ?? []
```

Renaming a manifest field is a ten-file change that the type system catches only
because `ProjectDefinition` is exported at all.

## Deepening

Two moves, and the second is the one that matters:

1. Split the six concerns into six modules, each with its own interface and its
   own spec. `project-store.service.ts` has a 337-line spec today that tests one
   module doing six jobs.
2. Give the manifest a read accessor per list, so `ProjectDefinition`'s shape
   stops crossing the seam. A caller asks for the declared characters; it does
   not learn the field name.

## Relationship to the other tickets

**Ticket 02 depends on this.** A content kind that declares itself needs one
module to declare itself *to*. Today it would have to declare itself to a
55-member module and to ten direct readers.

## Open questions

- Six modules, or fewer? Zones and locale files are small; they may belong with
  the manifest rather than alone.
- Does `WorldDocument` ownership move with concern 1, or stay where it is? It is
  ~50 public members of real behaviour over packed buffers — deep already, and
  spec'd.
- Angular composition: six injectables, or one facade over six modules? A facade
  would keep the 55-member interface alive, which is the thing to avoid.

## Done when

- No module outside the manifest module reads `store.project()?.<field>`.
- A caller learns one concern's interface, not six.
- Each concern has its own spec; the 337-line combined spec is split with them.
- `npm run check` and the smoke run pass.

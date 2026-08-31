# 05 — Close the project store's read side

Status: done
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

## Decisions

Settled before the work started; the three questions above are answered here and
the `## Open questions` section is kept as the record of what was asked.

### Five modules, and `ProjectStoreService` keeps only what is left

| Module | Owns | Injects |
|---|---|---|
| `app/project/project-manifest.ts` — `ProjectManifest` | `project.json` as loaded: the definition signal, one read accessor per list, the declare/undeclare/path trios, the zone list | — |
| `app/project/world-library.ts` — `WorldLibrary` | the open documents, the active id, select/add/remove/rename/import, zone membership | `ProjectManifest` |
| `app/project/tile-set-library.ts` — `TileSetLibrary` | the loaded tile sets, their paths, and the rebuild a replacement forces | `ProjectManifest`, `WorldLibrary` |
| `app/project/write-ledger.ts` — `WriteLedger` | the content directory as a baseline, and every question a save asks of it | `ProjectManifest`, `WorldLibrary` |
| `app/services/project-store.service.ts` — `ProjectStoreService` | loading, `resetToShipped`, `source`, the locale files, the `localStorage` mirror | all four |

The graph is acyclic in that order. Three edges were forced and are recorded
because each one is where a different split would have looked tidier:

- **`WorldLibrary` → `ProjectManifest`, not the reverse.** `renameWorld`
  repoints `startWorld`, which is a manifest write, so the arrow has to run this
  way. That is what puts the regenerated manifest — `projectDefinition()` /
  `projectJson()`, which needs the documents — on `WriteLedger` rather than on
  `ProjectManifest`: the ledger is the only module below the store that sees
  both. It reads correctly there. The regenerated manifest *is* what a save
  compares against, and it is also what Play loads, which is the same fact.
- **`importDefinition` takes its tile set.** Building a `WorldDocument` needs
  one, and `TileSetLibrary` already rebuilds documents when a set is replaced.
  Rather than make the two mutually dependent, the one method that needed the
  other direction takes it as an argument.
- **Zone membership is `WorldLibrary`'s, the zone list is `ProjectManifest`'s.**
  `removeZone` refuses while a map is still in the zone, so it has to see the
  documents; the list itself is a manifest field and is read from there.

### `dirty` is computed, not set

`touch()` is public and called seventeen times from two screens, so it stays a
method. But a module below the store cannot call up to it, and every manifest
and world mutation has to mark the project changed.

So each of `ProjectManifest` and `WorldLibrary` bumps an `edits()` counter on
every mutation, and the ledger derives:

```ts
readonly dirty = computed(() => this.edits() > this.cleanAt());
```

`touch()` bumps the world counter, which is what an in-place edit to a
`WorldDocument` — a brush stroke — needs, since it changes no signal.
`refreshDirty()` keeps its meaning and its cost: it fingerprints once, and moves
`cleanAt` only when nothing is owed. Nothing becomes asynchronous.

A counter alone is not quite the old flag, and the gap is real rather than
theoretical: a project can owe the disk a write **the moment it loads**, with
nobody having edited it — one that declares no zone is about to have the
implicit default materialised into its file (`docs/adr/ADR-0018-map-zones.md`),
which is a case the spec already tested. `refreshDirty()` could then only lower
the flag, never raise it. So `dirty` is `owed() || edits() > cleanAt()`, where
`owed` is what `refreshDirty` sets when it looks and finds a debt. The hot path
is still two integers.

The `localStorage` mirror follows the same counters from an `effect` in the
store, which makes it stronger than it was: today a mutation that forgets
`touch()` is not mirrored.

### No forwarding

Callers inject the module they use — 22 files. `ProjectStoreService` re-exports
nothing; a member that only forwarded is gone.

`DraftSource`'s `DraftManifest` port (`manifestNeedsWriting`, `projectJson`,
`markManifestWritten`, `refreshDirty`) is satisfied structurally by `WriteLedger`
instead of by the store, so `draft-set.ts` is unchanged and the six adapters pass
the ledger where they passed the store.

## Relationship to the other tickets

**Ticket 02 depends on this.** A content kind that declares itself needs one
module to declare itself *to*. Today it would have to declare itself to a
55-member module and to ten direct readers.

## Outcome

Landed as designed: five modules, no forwarding, 22 caller files moved.

| | Before | After |
|---|---|---|
| `project-store.service.ts` | 1,029 lines, **55 public members**, six concerns | 411 lines, **5 public members** — `ensureLoaded`, `resetToShipped`, `localeFiles`, `setLocaleFiles`, and the mirror |
| `ProjectManifest` | — | 318 lines, 35 members |
| `WorldLibrary` | — | 273 lines, 21 members |
| `WriteLedger` | — | 260 lines, 16 members |
| `TileSetLibrary` | — | 84 lines, 6 members |
| specs | one, 337 lines, one module doing six jobs | four, 527 lines, two of them covering modules that had none |

`ProjectManifest`'s 35 is the largest and is not a failure of the split: 20 of
them are the read accessors the second half of this ticket exists to add — one
per manifest list — and each is one line over a `computed`. That interface is
wide because *the manifest has twelve lists*, not because it is shallow.

Three things the work found that the design did not predict:

- **`source` is not dead.** It was dropped early on the evidence of `grep` and
  `tsc`, both of which miss a member read only from a template — the map
  editor's *open map* panel shows it beside the dirty flag. The Angular
  template compiler caught it; `npx tsc -p tsconfig.app.json` does not. It lives
  on `WorldLibrary` with the documents it describes. **A member is not unused
  until the templates have been grepped too.**
- **The mirror must not run on the effect's first pass.** An Angular `effect`
  runs once on subscription, so mirroring "on any edit" wrote `localStorage`
  immediately after a clean load — and the next page load then called itself
  `restored` when it had restored nothing. The smoke run caught it as
  `source: shipped → restored` on `editor-map-settings`; no unit test did.
  `persist()` now returns early while `edits() === 0`, and two tests in
  `project-store.service.spec.ts` pin both halves.
- **`DraftManifest` was renamed `DraftLedger`.** The port's four members are
  `WriteLedger`'s, not `ProjectManifest`'s, and leaving it named `manifest`
  would have made every adapter read `manifest: this.ledger`. `draft-set.ts`
  changed after all — four lines.

### What the review caught

`/code-review high` found one real defect and three pieces of dead weight:

- **`resetToShipped()` stopped clearing the mirror.** The same class of bug as
  the one above, one level deeper. The mirror is an `effect`, so it runs *after*
  the signals it watches settle — which means after `resetToShipped` has called
  `clearStored()`. The `edits() === 0` guard did not stop it, because the
  counters are monotonic for the life of the process and nothing resets them:
  any edit made before the reset left `edits() > 0` forever. So "Reset to
  shipped content" wrote the discarded session straight back, and the next
  reload called itself `restored`. The guard is now against `openedAt` — the
  count the current session opened at, set by `adopt`. Reproduced with a failing
  test first, which is now
  `project-store.service.spec.ts` → *leaves the mirror cleared after a reset*.
- **Four dead `ProjectStoreService` injections** left behind by the rewiring
  (`title-screen.service.ts`, `settings.service.ts`, `title-editor-page.ts`,
  `settings-editor-page.ts`) — removed. Nothing in the gate catches these:
  there is no TS lint step and `noUnusedLocals` is off.
- **`WorldLibrary.title` was dead before the split** and had been carried across
  unchanged — removed rather than moved, per this ticket's own rule.
- **`TileSetLibrary` had no spec**, which *Done when* requires of every concern.
  It has one now: seven cases, including the two failure modes that look like
  success — a map silently emptied by a deleted tile, and a rebuild that makes
  every map owe the disk a write.

Two findings the review raised were already fixed while it read: `replaceTileSet`
calling `worlds.rebuild()` rather than `adopt()`, and `dirty` gaining the `owed`
term.

One inconsistency was found and **deliberately not fixed**, because 05 is a
depth change and `spec.md` says nothing here changes what the game does:
`locale-authoring.service.ts:219` writes `project.json` from the manifest **as
loaded** (`serializeProject(this.manifest.require())`), where `draft-set.ts`
writes it **as regenerated** (`ledger.projectJson()`). Saving languages while
the map editor holds an unwritten new map would therefore write a manifest that
does not list it. Worth its own ticket.

`play-page.ts` did change behaviour in one edge case, and this is intended: it
resolved the start world against the manifest as loaded while handing the engine
the regenerated one two lines above, so the two could disagree about a map that
no longer exists. Both now read `ledger.projectDefinition()`.

Verified: `npm run check` green (503 web tests, 40 files); smoke run `clean` —
transcript identical, no console problems, `editor-map-settings` back to
`identical`. Against **clean `HEAD`** rather than the stale baseline: transcript
identical and all 75 canvas signatures identical.

**The smoke baseline is stale** and not from this work: it was recorded at
`2680070` (2026-08-29 17:46), before ticket 04 landed, and shows 972 locale keys
where both clean `HEAD` and this branch show 974. Confirmed by running the
harness on a stashed tree. Not accepted here — re-baselining is 04's debt to
settle, not this ticket's to bury.

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

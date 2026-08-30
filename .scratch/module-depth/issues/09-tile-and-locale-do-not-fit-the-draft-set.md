# 09 — Tile and locale do not fit the draft set

Status: ready-for-agent
Strength: strong
Blocked by: [05](05-close-the-project-store-read-side.md) — for the tile half

Split out of [04](04-one-editing-session-for-the-workspaces.md) during 04e, on
the instruction 04 gives for exactly this case: *"If those three do not fit the
pipeline cleanly, stop and ticket them separately rather than bending
`DraftSet` to fit."* Three of the five moved. Two did not, and the reasons are
different.

## What moved in 04e

`settings-editor-page.ts`, `title-editor-page.ts` and
`character-creation-editor-page.ts` are `DraftSet`s holding one draft, which is
what 04 predicted: *"the single-document pages hold a `DraftSet` whose list
happens to be length 1."*

They needed two hooks the three list kinds do not, and both turned out to be
real shared concepts rather than accommodations:

- **`blank()`** — what to open when the project declares nothing. All three had
  written *"nothing authored yet: start from a … that already validates"*, and
  all three marked it unwritten on the spot. A list kind answers `null`.
- **`declaredInManifest`** — whether saving this kind can move `project.json`.
  Settings and the title screen live at a fixed path and list nothing, so they
  must not flush a manifest another screen has left half-edited. Without the
  flag they would have started doing exactly that.

## Why `locale-editor-page.ts` did not move

**There is no draft.** `save()` is one call:

```ts
const outcome = await this.locales.save();
```

No path, no serializer, no validator, no report, no per-id dirtiness, no
document. `LocaleAuthoringService` already *is* the editing session for
languages — it owns the entries, the dirty flag and the write — and it has a
spec (`locale-authoring.service.spec.ts`).

04's seam table proposed a `locale` adapter owning the list. Read against the
code, that adapter would have to answer `pathOf`, `serialize`, `validate`,
`adopt`, `declare` and `keysOf` with stubs, so that `DraftSet` could call
`workspace.writeJson` on something `LocaleAuthoringService` writes itself,
across many files at once. `DraftSet` would own nothing.

**Recommendation: close this half as not-to-do.** The right deepening for the
language table, if one is wanted, is a different one: `locale-editor-page.ts`
is 207 lines and its service is already spec'd, so there is little depth to
gain. Say so in the spec rather than leaving a row implying work.

## Why `tile-workspace.ts` did not move

Not a misfit of shape — a misfit of *editing model*, plus a dependency on 05.

**Its editing model is mutate-then-touch, not copy-on-edit.** Every other
screen edits through `edit(mutate)` over a `structuredClone`. Tile mutates its
working copy in place and bumps a revision:

```ts
// tile-workspace.ts:456
const set = this.editable();
set.tiles.push(blankTile(id, id));
this.selectedTileId.set(id);
this.touch();               // dirty = true; status = null; revision += 1
```

There are roughly thirty of these. Converting them is a rewrite of how the
screen edits, and the repaint path is driven by `revision()` rather than by
document identity, so a half-converted screen still compiles and still draws —
which is the worst failure mode to hand a reviewer.

**Its list belongs to `ProjectStoreService`, which is 05's subject.** `working`
is a lazy overlay: a `Map<string, TileSetDefinition>` of edited copies over
`store.tileSetDefinitions()`, with `tileSet()` reading through it. A `DraftSet`
would have to either copy the store's array in eagerly at load — deciding who
owns that read, which is exactly what [05](05-close-the-project-store-read-side.md)
is for — or gain a lazy-overlay hook no other adapter wants.

**Its save is a different order for a stated reason.** Sprites are written
*before* the definition, and the comment says why: *"Art and definition are one
act of authoring, so they are written together."* `DraftSet` writes the file
first and the images after. Neither order is wrong; they cannot both be the
pipeline.

What tile *does* share and has already taken from 04: `describeError`,
`slugId`, `zoomBy`, and (in 04f) the density policy.

## What this ticket is

Two things, and the first is small:

1. **Delete the `locale` row** from 04's seam table in the spec, with the
   reason above. No code.
2. **After [05](05-close-the-project-store-read-side.md) lands**, move
   `tile-workspace.ts` onto `DraftSet` with a store-backed `DraftSource`,
   converting its thirty mutate-then-touch sites to `edit(mutate)` in the same
   change. The seam already has six adapters without it, so this is for tile's
   own sake — one definition of unsaved and a spec that runs without a canvas —
   not to evidence the seam.

## Done when

- The spec no longer proposes a locale adapter.
- `tile-workspace.ts` holds no `load`/`save` choreography of its own.
- Its dirtiness is the session's, not a hand-rolled boolean.
- `npm run check` and the smoke run pass, with unchanged screenshots.

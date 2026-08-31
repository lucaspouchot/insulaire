# 09 — Tile and locale do not fit the draft set

Status: done
Strength: strong
Blocked by: — ([05](05-close-the-project-store-read-side.md) landed; the tile half is unblocked)

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

**Its list belonged to `ProjectStoreService`, which was 05's subject.** `working`
is a lazy overlay: a `Map<string, TileSetDefinition>` of edited copies over
`tileSets.tileSetDefinitions()`, with `tileSet()` reading through it. A `DraftSet`
would have to either copy that array in eagerly at load — deciding who owns that
read, which is exactly what [05](05-close-the-project-store-read-side.md) was
for — or gain a lazy-overlay hook no other adapter wants. **05 has since landed**,
and the read now belongs to `TileSetLibrary`, a 5-member module.

**Its save is a different order for a stated reason.** Sprites are written
*before* the definition, and the comment says why: *"Art and definition are one
act of authoring, so they are written together."* `DraftSet` writes the file
first and the images after. Neither order is wrong; they cannot both be the
pipeline.

What tile *does* share and has already taken from 04: `describeError`,
`slugId`, `zoomBy`, and (in 04f) the density policy.

## What this ticket is

Two things. The first is done: 04's seam table now shows the `locale` row
struck through, with the reason above, and `spec.md`'s Order says so.

1. **Character's playback clock.** `character-workspace.ts:697` still
   hand-rolls `startClock`/`stopClock`, where decoration and object now hold a
   `FlipbookClock`. It is a genuine misfit — a skeleton animation has a
   playback *speed* and a frame *count*, and is not a flipbook — so it was left
   alone, and this records that rather than leaving it unexplained. The
   deepening, if one is wanted, is a clock over `Animation` rather than over
   `Flipbook`; the two would share the ticker and the play/pause, not the
   frame arithmetic.
2. **[05](05-close-the-project-store-read-side.md) has landed**, so the tile
   half is now unblocked: move
   `tile-workspace.ts` onto `DraftSet` with a `DraftSource` backed by
   `TileSetLibrary`,
   converting its thirty mutate-then-touch sites to `edit(mutate)` in the same
   change. The seam already has six adapters without it, so this is for tile's
   own sake — one definition of unsaved and a spec that runs without a canvas —
   not to evidence the seam.

## Done when

- `character-workspace.ts` either holds a clock module or says in one comment
  why it holds its own.
- `tile-workspace.ts` holds no `load`/`save` choreography of its own.
- Its dirtiness is the session's, not a hand-rolled boolean.
- `npm run check` and the smoke run pass, with unchanged screenshots.

## Comments

**Both halves are closed.** The locale half was closed as not-to-do when this
ticket was written — 04's seam table shows the row struck through and `spec.md`
says why. The two remaining items are done:

**1. Character's playback clock — left alone, and it already says so.**
`character-workspace.ts:701` carries the paragraph this ticket asked for: *"it is
this screen's own rather than `app/editing/flipbook-clock.ts` … A flipbook is a
list of images at a rate; a character animation is a frame **count** with tracks
over it, played at a speed the author sets, and it stops itself at the end when
it does not loop."* Nothing to change; the deepening named here — a clock over
`Animation` rather than over `Flipbook` — is still the one to write if anybody
wants it.

**2. `tile-workspace.ts` is on `DraftSet`.** Not a line-count win, and worth
saying so plainly: the file went 1,374 lines to 1,409, because the prose grew
more than the code shrank. The code itself went **965 statements to 937**, and
across the pair with `tile-editor.types.ts` it went *up*, 1,095 to 1,118 — a new
`assetsOf` and `hasLevel` have real bodies, and the adapter is fifty lines.

What was bought is depth, not size: the twenty steps of load and save are no
longer written here at all, and what replaced them is a description of what a
tile set *is* to the pipeline. The fourth copy is what went.

- **The draft is the *set*.** `DraftSet<TileSetDefinition>`; the tile inside it
  stays the screen's own business, which is what 04 predicted for tile's nesting.
- **The list is `TileSetLibrary`'s**, read in eagerly at load and cloned per
  draft. That is the choice 05 unblocked: no lazy-overlay hook, no `working` map,
  and nothing edits the definition the library handed out.
- **Thirty mutate-then-touch sites became `edit(mutate)`**, through one
  `editTile(mutate)` helper that finds the tile in the set's copy. `revision`,
  `working`, `editable()`, `editableTile()`, `touch()`, `dirty`, `status` and
  `failure` are all gone, and with them the two `equal: () => false` signals that
  existed only because the working copy was mutated in place.
- **One definition of unsaved.** `dirtySprites` answers which images the set
  owns; `SpriteDocument.unsaved` is an input rather than a second answer. The
  clearest case: importing an image used to call `touch()` and mark the
  *definition* changed, when only pixels had moved.
- **A spec that runs without a canvas.** `listFor`, `hasLevel`, `imageHeight`,
  `dropOf`, `levelOfTab` and a new `assetsOf` moved into
  `tile-editor.types.ts` — the file that exists for exactly this split — and
  `tile-editor.types.spec.ts` grew six cases over them, from 12 to 18.

### Decisions taken while doing it

- **`declaredInManifest: false`.** A tile set *is* listed in `project.json`, so
  the flag reads oddly, but the flag's own documentation asks the narrower
  question — *can saving this kind move the manifest?* — and the answer for this
  screen is no: it edits the sets a project declares and creates or removes none.
  `true` would have been a behaviour change, letting a tile save flush a
  `project.json` the map editor had left half-edited. `declare`, `undeclare`,
  `forget` and `removed` are empty for the same reason, under one comment.
  `CONTEXT.md`'s **manifest** entry now says this, because the vocabulary as
  written implied the opposite.
- **The save order changed, as this ticket said it would.** `DraftSet` writes the
  definition and then the images; tile wrote the images first. Both orders keep
  art and definition one act of authoring (ADR-0028); they cannot both be the
  pipeline, and the pipeline's is the one that stands.
- **One scope for every question about pixels.** `dirtySprites`, the toolbar's
  count and `writeSprites` all answer over `assetsOf(openSet)`, through one
  `unwritten(set)`. The first draft of this change had the count and the write
  spanning all of `sessions` — the object editor's looser answer — and the
  review found what that costs with two declared sets: the toolbar claims
  unwritten pixels for a set nobody is looking at, and saving *this* one writes
  the other's PNG and counts it in its own message. The seam already says which
  scope is meant — *"images this draft owns"* — and the honest reading of it was
  the right one.
- **No unload guard was added.** `anyUnsaved` is now available and the other
  workspaces use it, but this screen never had one and adding it is a behaviour
  change nothing here asked for. Worth a ticket, not a smuggled line.

### What the review caught

Three real defects, all fixed before the commit:

- **The error banner was still wrapped.** It rendered `error()` through
  `ui.editor.asset.failed` — *"Nothing was written: {message}"* — but the
  session's error signal is not only about writes: `refresh()` puts a failing
  serialize or validate there while an author is still typing, and `save()` puts
  the already-complete `invalid` sentence there. It now renders raw, as the three
  sibling workspaces do. `ui.editor.asset.failed` had no other caller and is
  gone.
- **The sprite scope disagreed with itself** — the entry above.
- **`importImage` read a stale draft.** It captured `this.tile()`, awaited the
  decode, then resolved the variant from that snapshot. Under the old code that
  snapshot *was* the live working object; a copy-on-edit draft is not, so a
  variant moved during the decode would have stored the pixels under a path the
  set no longer names. It re-reads after the awaits.

The review also asked whether the flipped save order was intended: it is, and it
is written down two entries up.

### Verification

`npm run check` passes: 36 ADRs resolve across 2,232 files, clippy and rustfmt
clean, 450 Rust tests, 518 web tests in 41 files, 61 script tests. The smoke run
is `clean` — transcript identical, no console problems.

One screen moved and it is explained: `editor-locale` reads **974 keys → 975**,
because the Languages tab lists application strings and this change is net one
key — two added (`ui.editor.asset.invalid`, `ui.editor.asset.imagesSaved`), one
removed (`ui.editor.asset.failed`, which lost its last caller). All are defined
in both languages, so `0 untranslated` is unchanged.

The tile screens are `similar` rather than `identical`, at a maximum channel
delta of 4 over at most 44 pixels. That is pre-existing run-to-run noise, not
this change: the same run on a stashed tree moves the same screens *more* — 89
pixels on `editor-asset-tiles-surface` against 44 here — and the `play*` screens
drift identically with and without the change. Looked at side by side, the tile
screens are the same picture: the same tile selected, the same tab open, the
same variants listed, the same verdict.

### Follow-up — the three bare-path failures (2026-08-31)

A code review of 01 reached back into this ticket's commit and found that
dropping `ui.editor.asset.failed` left three `drafts.fail` call sites in
`tile-workspace.ts` passing a bare path instead of a sentence: an undecodable
variant reported `assets/tiles/dirt/flat/dirt_a.png`, an undecodable import
reported `dirt.png`, and a size mismatch reported
`dirt.png: 32×48 ≠ 32×64`. `DraftSet.fail` runs its argument through
`describeError`, which returns a string unchanged, so that is what the banner
read — no verb, and untranslated for a French author.

**The wrapper stays discarded.** The reason this ticket gave for removing it
holds: the error signal also carries a failing verdict while an author is still
typing, where "Nothing was written" would be false. What was wrong was not the
removal but these three arguments — every other `drafts.fail` in the editor
passes a thrown `cause`, which is already a sentence, or an `i18n.t(...)`.

Fixed by giving the three their own keys rather than by restoring a wrapper:
`ui.editor.asset.imageUnreadable`, `importUnreadable` and `importWrongSize`,
defined in both languages. The Languages tab reads 978 keys where it read 975.

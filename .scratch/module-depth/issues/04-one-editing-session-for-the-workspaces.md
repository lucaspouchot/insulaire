# 04 — Give the asset workspaces one editing session

Status: done
Strength: strong
Blocked by: —

**First of the seven**, after [08](08-adr-references-must-resolve.md). See [../spec.md](../spec.md) for why.

Design settled by grilling — see `## Decisions`. Sub-tickets 04a–04f are the
commit order; this file is the parent.

**Landed** as seven commits (04a–04f plus the documentation and its guard), with
the deviations recorded inline below: `frameDurationOf` rather than `durationOf`,
an amendment to ADR-0015 rather than a new ADR, an import-graph check rather than
a chunk grep, and the locale row withdrawn. Tile and the language table did not
fit and are [09](09-tile-and-locale-do-not-fit-the-draft-set.md).

## Problem

Four asset workspaces, 6,303 lines, **no spec on any of them**:

```
character-workspace.ts   2,686
decoration-workspace.ts  1,418
tile-workspace.ts        1,356
object-workspace.ts        843
```

They re-implement the same three modules, none of which exists:

| | Members repeated |
|---|---|
| **editing session** | `open` `load` `edit` `save` `markUnsaved` `onUnload` `refresh` `refreshFiles` `setId` `setName` |
| **flipbook clock** | `startClock` `stopClock` `togglePlay` `repose` |
| **sprite canvas** | `setResolution` `touchSprites` `writeSprites` `fitZoom` `zoomBy` |

21 member names are shared by character, decoration and object; decoration and
object share 32. `markUnsaved` is byte-identical in all three:

```ts
// character-workspace.ts:874, decoration-workspace.ts:527, object-workspace.ts:321
private markUnsaved(id: string): void {
  this.unsaved.update((ids) => (ids.includes(id) ? ids : [...ids, id]));
}
```

`load` (character:771, decoration:415, object:228) runs the same steps in the
same order: `engine.ready()` → `i18n.ensureAdopted()` → `store.ensureLoaded()` →
`workspace.ensureProbed()` → `library.ensureLoaded()` → `refreshFiles()` → read
the manifest list → `Promise.all(map(fetch))` → set documents → set unreadable →
open the first → `refresh()`, in the same `try / catch (cause) / finally`.

`save` (character:1757, decoration:974, object:758) runs the same ten steps:
serialize → validate → bail on errors → compute path → `writeJson` →
`library.adopt` → build a message → `writeSprites` → `declare<Kind>` → manifest
write check → `refreshDirty` → `locales.ensureKeys` → clear unsaved → `refresh`.

Roughly **420 lines of identical choreography** across three files, plus a
fourth, divergent copy in `tile-workspace.ts`.

The only shared modules are at the wrong altitude: `asset-workspace.ts` (108
lines) is the layout frame, and `asset-editing.ts` (42 lines) is three arithmetic
helpers. The session between them is copied.

## The copies have already drifted

This is the part that makes the ticket urgent rather than tidy.

**`devicePixelRatio` — six sites, four policies.** Three preview panes render at
three different effective resolutions on the same high-DPI screen:

```
renderer/canvas-view.ts:225                   Math.min(window.devicePixelRatio || 1, 3)
asset/decoration-workspace.ts:1186            Math.min(2, window.devicePixelRatio || 1)
asset/character-workspace.ts:2320             explicit >= 4 ? 1 : Math.min(dpr || 1, 3)
asset/tile-workspace.ts:1237                  window.devicePixelRatio || 1        (uncapped)
creation/character-creation-editor-page.ts:758 Math.max(1, dpr || 1)              (uncapped)
character-creation/character-creation-page.ts:291 Math.max(1, dpr || 1)           (uncapped)
```

**`freeId` — two functions, one name, different behaviour.**
`asset-editing.ts:21` appends `_2`, `_3` to the stem verbatim.
`tile-editor.types.ts:135` slugifies first
(`toLowerCase().replace(/[^a-z0-9]+/g, '_')`), then appends. A caller who knows
one does not know the other.

**Undo/redo — two parsers of one keystroke, live at once.**
`pixel-editor.ts:144` attaches its own `window.addEventListener('keydown', …)`.
`character-workspace.ts:195` binds `'(document:keydown)': 'onKeyDown($event)'`
and re-parses the same ctrl/meta + `z` + shift logic into its own
`undo()`/`redo()` (2087–2118). Both are listening on the character screen.
`tile-workspace.ts:1063` has `undo`/`redo` as toolbar buttons and no listener at
all, so Ctrl+Z there depends on whichever `PixelEditor` happens to be embedded.

**`describe(cause)` — nine byte-identical copies**, at
`character-workspace.ts:2684`, `decoration-workspace.ts:1416`,
`object-workspace.ts:841`, `map-editor-page.ts:1844`,
`settings-editor-page.ts:718`, `locale-editor-page.ts:205`,
`title-editor-page.ts:317`, `character-creation-editor-page.ts:934`,
`play-page.ts:919`. `tile-workspace.ts:924` inlines the same expression.

**Two vocabularies for one concept.** `unsaved: string[]` + `markUnsaved(id)` in
three workspaces; `dirty: boolean` hand-rolled in four more editor pages
(`tile-workspace.ts:203`, `settings-editor-page.ts:81`, `title-editor-page.ts:64`,
`character-creation-editor-page.ts:84`); and a third `dirty` computed on
`ProjectStoreService` itself (`project-store.service.ts:143`).

## Why none of it is tested

Each workspace is an Angular `@Component` with a `templateUrl`, reading
`viewChild<ElementRef<HTMLCanvasElement>>` and calling `getContext('2d')` inline
(`decoration-workspace.ts:1176`, `character-workspace.ts:~2310`,
`tile-workspace.ts:~1230`). Nothing in them is reachable without `TestBed`, a DOM
and a working `CanvasRenderingContext2D`.

Logic that could be pure is stranded inside them: `decoration-workspace.ts:902`
`durationOf(animation)` and `:913` `frameOf(animation, timeMs)` take only their
arguments, do arithmetic, and return a value — and can only be exercised by
instantiating a 1,418-line component.

Only two of the four extracted a companion pure-logic module, and only one of
those has a spec: `tile-editor.types.ts` (234 lines, spec'd);
`character-editor.types.ts` (346 lines, 15 pure functions, **no spec**);
decoration and object have none at all.

## The shape to copy is already here

- `apps/web/src/app/services/content-library.ts` — 130 lines, three abstract
  members, three subclasses at ~43 lines each. Same problem shape: read a
  manifest list, fetch each file, register with the engine.
- `apps/web/src/renderer/hex-map-renderer.ts` — 2,010 lines, 19 public members,
  a 1,325-line 36-test spec. Testable because it takes a
  `CanvasRenderingContext2D` in its constructor instead of being a component.

## Deepening

Three modules behind the workspaces, each testable without a DOM:

- **editing session** — the documents, which one is open, what is unsaved, and
  the load/save choreography.
- **flipbook clock** — play/pause, current frame at a time, `repose`.
- **sprite canvas** — resolution, DPR, fit and zoom, on a supplied context.

A workspace keeps only what makes its kind that kind — the `ContentLibrary`
bargain, one level up.

## What this does not change

ADR-0028 ("one editor for everything drawn") is the reason to do this, not an
obstacle: the decision is already that these share an editor; the workspaces just
never shared more than the frame.

## Decisions

Settled by grilling. The vocabulary is `codebase-design`'s: **module**,
**interface**, **depth**, **seam**, **adapter**, **leverage**, **locality**.

### The three modules

```
content/flipbook.ts          frameAt(animation, timeMs) · durationOf(animation)
                             pure, no signals                      play + editor

renderer/canvas-surface.ts   density (min 3) · fit(bounds) · zoomBy
                             pure, takes a context                 play + editor

app/editing/draft-set.ts     documents · openId · open · dirty · anyUnsaved
                             busy · error · message
                             load() · select(id) · edit(mutate) · save(id)
                             signals                               editor only
app/editing/flipbook-clock.ts  playing · timeMs · togglePlay
                             wraps content/flipbook, injected ticker  editor only
```

Held modules, not abstract base classes: the win is 6,303 lines becoming
testable without a DOM, and a base class does not buy that. `HexMapRenderer` is
the proof — the largest module in the app has a 36-test spec because it takes a
`CanvasRenderingContext2D` in its constructor.

`DraftSet` uses `signal()` and `computed()` but never `inject()` or `effect()`
in its own body; dependencies arrive through the constructor. That keeps it in
the 26-spec no-`TestBed` majority rather than the 4-spec minority.

### Why the modules split where they do

Insulaire has two builds (ADR-0015). The client build must load the minimum, and
`verify-client-build.mjs` guards it by grepping emitted chunks for two component
selectors — which a straddling module would walk straight past.

Decorations and objects animate in play, and `CanvasView` is play-side, so the
clock's and the canvas's **pure cores** belong in the play graph. They go in
`content/` and `renderer/`, which are framework-free by policy — which is also
why they carry no signals. Only the editor-only halves live in `app/editing/`.
The dependency arrow points editor → shared, never back.

### The seam

`DraftSource`, with three real adapters — one would be a hypothetical seam,
three is an evidenced one:

| Adapter | Owns the list | For |
|---|---|---|
| owned | `DraftSet` itself, calling `ContentLibrary` to register | character, decoration, object |
| store | `ProjectStoreService` | tile |
| ~~locale~~ | ~~`LocaleAuthoringService`~~ | ~~locale~~ |

**The locale row is withdrawn.** Read against `locale-editor-page.ts` there is
no draft to hold: no path, no serializer, no validator, no report, no per-id
dirtiness. `LocaleAuthoringService` already is that screen's session and has a
spec. The adapter would have answered six members with stubs so that `DraftSet`
could own nothing. `store` is still wanted, and waits on
[05](05-close-the-project-store-read-side.md); see
[09](09-tile-and-locale-do-not-fit-the-draft-set.md). Six `owned` adapters
shipped, which is the evidence the seam needed.

`ContentLibrary` is untouched and stays a peer. It passes the deletion test on
its own — delete it and re-registration reappears in three places — and it is
already the right shape. `DraftSource` calls it; it does not absorb it.

`save` is a **fixed pipeline in `DraftSet`** — validate, bail, write, declare,
refresh — calling adapter hooks at the kind-specific points: serializer,
validator, path, `writeSprites`, `locales.ensureKeys`, and *which sprites this
draft owns*. If the adapter owned `save` outright we would have moved 45 lines
into three adapters and gained only indirection. "A draft with validation errors
is never written" is the module's invariant, not each kind's.

### Dirtiness

A set of dirty draft ids, with `anyUnsaved` derived. A draft is dirty if its
definition changed **or** any sprite it owns is dirty — the adapter answers
which sprites those are, so `SpriteDocument.unsaved` stops being a parallel
truth and becomes an input. `ProjectStoreService.dirty` stays out of it; that is
worlds, and it belongs to [05](05-close-the-project-store-read-side.md).

One interface serves 1-document and N-document editors: the single-document
pages hold a `DraftSet` whose list happens to be length 1. Tile's nesting — one
set containing many tiles — stays the workspace's own business.

### Two behaviour calls

**`freeId` keeps both behaviours, under two names.** `freeId(stem, taken)`
appends a suffix; `slugId(name, taken)` slugifies then delegates. The defect is
that two different jobs shared one name, not that there are two jobs. Zero
behaviour change.

**Editor chords use `event.key`, game actions use `event.code`.** Ctrl+Z follows
the *printed letter* — a French author presses the key marked Z — while WASD
follows *physical position*, which is why ADR-0032 chose `code`. Both are right
for their job. ADR-0032's scope is rebindable one-key game actions, not editor
chords, so it does not govern this. **This goes in `CONTEXT.md`**, because the
next reader will otherwise see an inconsistency and correct it in the wrong
direction.

### Also landing

- **`CONTEXT.md`**, created — `draft`, `draft set`, `draft source`, `flipbook
  clock`, `canvas surface`, plus the two reserved calls: *session* means a game
  in progress (ADR-0023), never an editor's; and the `key`/`code` split above.
- **One new ADR** on which build may import a shared editing module, written
  after the first module lands so it records what exists. Via `/create-adr`.

  *Outcome: an amendment to ADR-0015, not a new file.*
  `.claude/commands/create-adr.md` says most decisions touching an existing one
  are an edit to it, and calls opening a new file here the defect that produced
  fifty-one ADRs. This is ADR-0015's own subject — what a client build may
  contain — and it closes a gap ADR-0015 already listed as a negative.
- **`verify-client-build.mjs`** gains an assertion that no emitted chunk carries
  anything from `app/editing/`.

  *Outcome: an import-graph check, not a chunk grep* (`scripts/client-graph.mjs`).
  The existing grep works because a component selector is a string literal
  minification cannot rename; `app/editing/` is pure functions and leaves no
  such literal, so grepping for one would have meant planting a marker string
  and hoping nobody shook it out.
- **`docs/architecture.md`** repository layout, per `.claude/rules/specs.md`.

### Commit order — one branch, six commits

| | Commit | Baselines |
|---|---|---|
| 04a | leaf helpers — `describe`, `freeId`/`slugId`, `isTyping` | 72 unchanged |
| 04b | `content/flipbook.ts` + spec, test-first | 72 unchanged |
| 04c | `renderer/canvas-surface.ts` + spec; `CanvasView` adopts | 72 unchanged |
| 04d | `DraftSet` + `DraftSource` + specs; three workspaces move | 72 unchanged |
| 04e | the three single-document pages move; tile and locale split out to [09](09-tile-and-locale-do-not-fit-the-draft-set.md) | 72 unchanged |
| 04f | density unified · one undo listener · tile gains Ctrl+Z | **moves, reviewed by eye** |

Specs are written **test-first**, with each module, in the commit that creates
it. `character-editor.types.spec.ts` comes before that file is touched at all —
it is the one place a pure module already exists and is silently unverified.

04f is the only commit permitted to move a screenshot. Anything moving in
04a–04e is a defect introduced by the move.

### Known risk

**04e has the least evidence behind it.** The 21 shared member names are
measured across character/decoration/object, not across settings/title/
character-creation. If those three do not fit the pipeline cleanly, stop and
ticket them separately rather than bending `DraftSet` to fit.

**Outcome.** The three named here fit, and needed two hooks that turned out to
be shared concepts rather than accommodations: `blank()` and
`declaredInManifest`. The two that did not fit were the two this clause did not
name — `tile-workspace.ts` and `locale-editor-page.ts` — and they are
[09](09-tile-and-locale-do-not-fit-the-draft-set.md), with the reasons written
down there.

## Done when

- One module decides what "unsaved" means; the two vocabularies become one.
- One canvas policy, not four.
- One `describe`, one `freeId`, one undo/redo parser.
- The editing session, the flipbook clock and the sprite canvas each have a spec
  that runs without a DOM.
- `character-editor.types.ts` gets its spec.
- The four workspaces shrink to what is kind-specific.
- `npm run check` and the smoke run pass, with unchanged screenshots.

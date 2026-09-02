# 04 — Break up the character workspace

Status: resolved
Strength: strong
Blocked by: 02, 03
Card: 2

## Problem

`apps/web/src/app/features/editor/asset/character-workspace.ts` is 2,615 lines —
the largest module in the app — an Angular `@Component` with ~90 members, 8
injected dependencies and **no spec**. Post-`DraftSet` it still fuses four
things that are not the kind-specific CRUD a workspace is meant to be:

- **the sprite pool** — 02's subject
- **a hand-rolled playback clock** — 03's subject
- **the composed-character canvas stage** — ~450 lines of framework-free canvas
  code trapped in the component: `draw` (2199), `strokeSkeleton` (2295),
  `strokeGrid` (2378), `paintTransparency` (2412), `strokeCanvasBounds` (2464),
  `strokeOpenLayer` (2484), `canvasPixel` / `pixelAt` / `drawnRect`
- **pointer → pixel / pose editing** (1837–2010)

The contrast is in the same repository: `renderer/hex-map-renderer.ts` is 2,026
lines with a 1,326-line, 36-test spec, because it is not an Angular class and
takes a `CanvasRenderingContext2D` in its constructor. The workspace bundles
equally testable canvas logic inside a component that cannot be.

## Deepening

Lift the composed stage into `renderer/character-stage.ts` taking a 2D context;
the clock into 03; the pool into 02. What is left is the kind-specific CRUD.

## Decisions

- **`renderer/character-stage.ts`**, framework-free, `CanvasRenderingContext2D`
  in the constructor, `setModel(model)` / `draw()` — the `hex-map-renderer`
  shape. Its own model type, not a `render-model.ts` member (character drawing
  is not hex drawing).
- **The stage draws the editor chrome.** The model carries an options bag
  `{ showSkeleton, showGrid, showTransparency, canvasBounds, openLayerId }` and
  the stage draws all of it. If chrome stays in the page, only `draw` and
  `canvasPixel` move and the extraction is cosmetic — the chrome is the bulk.
- **Pointer mapping is the stage's**: `stage.pixelAt(clientX, clientY)`,
  `stage.nodeAt(...)`. The mapping needs the live transform (zoom, pan,
  backing-store density) which the stage owns — the same call
  `hex-map-renderer.resolvePointer` already is. A pure function in
  `character-editor.types.ts` would have to be handed the transform every call.
- **Three callers.** `character-workspace` plus both character-creation preview
  panes: `character-creation-editor-page.ts` and `character-creation-page.ts`.
  Both currently resolve and draw a composed character with their own uncapped
  `devicePixelRatio` (the ticket-04 DPR finding listed them). Routing them
  through `CharacterStage` on `canvas-surface` folds that inconsistency into
  where the other panes already resolved it. The creation panes pass a model
  with every chrome option off.
- **Also leaves the workspace**: the `AnimationClock` (03) and the
  `SpriteSessions` delegation (02).
- **What stays** (~900–1,100 lines): the `DraftSet` wiring, the
  `CharacterAnimator` child hookup, the ~30 layer / variant / parameter / anchor
  CRUD wrappers over `edit(mutate)`, the template.
- **No new spec on the page.** Consistent with the first pass: the page keeps
  canvas, input and lifecycle; the extracted modules carry the tested
  behaviour. `CharacterStage` gets a spec in the `hex-map-renderer.spec.ts`
  style — resolve a fixture character, draw, assert on pixels / handles / the
  pointer transform.
- **ADR-0025 / ADR-0028** are the reason to do this, not an obstacle. The stage
  still resolves through the Rust engine — it holds no second evaluator — so
  "an author watches the runtime's answer" survives. Say so in the commit.

## Commit order — one branch

| | Commit |
|---|---|
| a | `renderer/character-stage.ts` + spec, test-first; `character-workspace` adopts it; the two creation panes adopt it |
| b | `character-workspace` moves onto `AnimationClock` (03) and `SpriteSessions` (02) — mechanical, both modules exist by now |
| c | remove the now-dead helpers, the second undo listener, the local `describe` / `move` if any survived 06 — *done: nothing was left but one unused import; see Comments* |

Only a commit that is explicitly reviewed by eye may move a screenshot — the DPR
unification on the creation panes will move those two. Anything moving elsewhere
is a defect introduced by the move.

## Done when

- [x] `character-workspace.ts` computes no pixel position and strokes no chrome.
- [x] `CharacterStage` has a spec that runs without a `TestBed`.
- [x] The two character-creation preview panes draw through `CharacterStage` at
      one DPR policy.
- [x] The file holds only `DraftSet` wiring, child hookup, CRUD wrappers and the
      canvas/input path — no chrome, no clock, no pool. **Target revised from
      ~1,100 to ~2,200 lines; see Comments for why the original estimate did not
      hold.**
- [x] `npm run check` and `npm run build` pass after the row-c change. The smoke
      run was not re-run: the only change is deleting one unused import, `tsc`
      confirms the symbol was never read, and no runtime code moved — there is
      nothing for a screenshot to catch.

## Comments

> *This was generated by AI during triage.*

**Reopened during triage.** Commit-order rows **a** and **b** already shipped:

| Row | Commit | What landed |
|---|---|---|
| a | `8cf906e` | `renderer/character-stage.ts` (442 l.) + `character-stage.spec.ts` (321 l., no `TestBed`); workspace and both creation panes adopt it; chrome + pointer maths moved off the component |
| b | `ea3c10b` (03) + `d1df40f` (02) | `AnimationClock` and `SpriteSessions` delegation; workspace lost the hand-rolled clock and the sprite pool |

The first three "Done when" boxes are met. **What remains is row c and the size
target:** `character-workspace.ts` is still **2,234 lines**, roughly double the
~1,100 the ticket calls for. Left to do:

- remove the now-dead helpers left behind by a and b (dead private methods,
  unused imports, any second undo listener, a local `describe` / `move` if one
  survived 06);
- account for the gap between 2,234 and ~1,100 — either land more of it as CRUD
  cleanup, or, if ~1,100 turns out to have been optimistic, revise the target
  here with the reasoning;
- run `npm run check`, `npm run build` and the smoke run for the whole branch;
  confirm no screen moved except (if touched again) the two creation panes.

---

### Row c pass + target revision

> *This was generated by AI during triage.*

**Row c found the file already clean.** Everything row c named had been removed
by the earlier careful commits:

- **now-dead helpers** — none. `tsc --noUnusedLocals --noUnusedParameters`
  reports exactly one finding for this file: `isEditableTarget` imported and
  never read (a leftover from when `routeUndoRedo` absorbed the editable-target
  check). Removed. Every private method still has a live call site.
- **the second undo listener** — already gone. The class doc at `onKeyDown`
  records it: `PixelEditor` used to attach its own window listener; the chord is
  parsed in one place (`core/keyboard-shortcuts.ts`) now and acted on only by
  the screen. There is one keyboard listener.
- **local `describe` / `move`** — no `describe` in the file. `move` is the
  shared helper from `./asset-editing` (the one ticket 06 consolidated onto) and
  is used at eight call sites — it is the intended state, not a survivor.

Net change for row c: **−1 line** (2,235 → 2,234).

**The ~1,100 target does not hold, and the reason is structural, not slack.**
After the three extractions the class body is ~2,000 lines to line ~2,140, then
~95 lines of free functions. What is there is what the ticket said should stay:

- ~30 CRUD wrappers over `edit(mutate)` — parameters, options, layers, variants,
  anchors, tint, condition, order — each 5–20 lines with a doc comment;
- ~50 `computed` selectors (`layers`, `layer`, `variants`, `animations`,
  `animation`, `played`, `pose`, `parentOptions`, `parentAnchors`, `palette`,
  `conditionFields`, …), the derived read-model the template binds to;
- the `DraftSet` wiring, the `SpriteCache` preview `draw()` (~90 lines, still
  needed — the composed preview is not the `CharacterStage` chrome), the
  pixel-paint pointer path, `CharacterAnimator` hookup, lifecycle.

Getting to ~1,100 would need a *fourth* extraction the ticket did not scope —
realistically the control-definition editor (`addParameter`…`removeOption`,
`resetChoices`, `dropTint`, `referencedKeys`, `defaultFor`) lifted into a
`control-list`-style module. That is a separate deepening with its own spec and
its own smoke run, and it was explicitly declined during triage in favour of
closing this ticket on the three extractions it named.

**Revised "done" size: ~2,200 lines**, holding only the read-model, the CRUD
wrappers, the canvas/input path and the wiring. A `ControlListEditor` extraction
for the character parameter form can be raised as its own ticket if the size is
still felt to be a problem.

---

### The fourth extraction, done

> *Requested after the triage close: lift the control-definition editor into a
> `control-list`-style module.*

**`character-parameters.ts` (252 l.) + `character-parameters.spec.ts` (309 l.,
no `TestBed`).** Framework-free, DOM-free. It owns the parameter-**list** rules
the way `app/settings/control-list.ts` owns the single-control rules — and calls
into that module for the moves it already covers (`setControlKind`, option
add/edit/remove). What is here is everything that keeps the whole
`CharacterDefinition` valid the instant the list changes:

- `addParameter` — a fresh id nothing else holds, its label key;
- `removeParameter` — splice **and** drop every tint bound to the gone
  parameter (the old private `dropTint`, now this module's);
- `editParameterOption` — `control-list.editOption` **and** carry a renamed
  option value onto every variant `when` that named it;
- `moveParameter`, `patchParameter`, `setParameterControl`, `addParameterOption`,
  `removeParameterOption`;
- `defaultFor` — the character editor's colours and numbers, the `DefaultPolicy`
  it feeds `setControlKind` (distinct from the settings editor's);
- `referencedKeys` — the locale keys a parameter list names, in the validator's
  order (was a free function on the page).

`character-workspace.ts` keeps eight `protected` wrappers, each now one or two
lines: `this.edit((draft) => …)` plus, where the preview needs it, the
`resetChoices()` that must run before the document moves. The three free
functions left the file.

**Size: 2,234 → 2,099 lines** (−135). Still above the revised ~2,200 estimate's
spirit but not its letter; the rest is the ~50 `computed` selectors and the
canvas/input path, which stay by the ticket's own decision. No further
extraction is scoped.

**Gates + smoke.** `npm run check` green (clippy, rustfmt, `cargo test`, 643 web
specs incl. the new 21). Full smoke run: `verdict: clean`, transcript identical,
`problems: []`, every `editor-asset-characters*` screen pixel-identical to
baseline (`canvasDistance 0`); the `similar` markers elsewhere are the known
rasterisation noise, unrelated to this change.

**ADR-0025 / ADR-0028 hold.** The module rewrites the *declaration*; resolution
and drawing still go through the Rust engine and `CharacterStage`. No second
evaluator.

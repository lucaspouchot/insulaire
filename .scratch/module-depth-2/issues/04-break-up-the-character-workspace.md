# 04 — Break up the character workspace

Status: ready-for-agent
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
| c | remove the now-dead helpers, the second undo listener, the local `describe` / `move` if any survived 06 |

Only a commit that is explicitly reviewed by eye may move a screenshot — the DPR
unification on the creation panes will move those two. Anything moving elsewhere
is a defect introduced by the move.

## Done when

- [ ] `character-workspace.ts` computes no pixel position and strokes no chrome.
- [ ] `CharacterStage` has a spec that runs without a `TestBed`.
- [ ] The two character-creation preview panes draw through `CharacterStage` at
      one DPR policy.
- [ ] The file is under ~1,100 lines and holds only `DraftSet` wiring, child
      hookup, CRUD wrappers and the template.
- [ ] `npm run check`, `npm run build` and the smoke run pass; the only moved
      screens are the two creation panes, reviewed by eye.

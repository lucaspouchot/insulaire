# Module depth, second pass: seven deepenings

Findings from an architecture review of `main` at `ad25610` (2026-09-02, v0.29.0).
The subject is **depth** — how much behaviour sits behind an interface — not
features. Nothing here changes what the game does on purpose.

The first pass (`.scratch/module-depth/`) shipped nine deepenings: the engine
seam declared once, the content kind as a module, the content types derived from
Rust, the draft set, the split project store, the one canonical writer, the
lifted session presentation. Those wins hold — `draft-set`, `canvas-surface`,
`session-presentation`, `flipbook-clock`, `render-model` are all deep with specs
that run without a DOM. This pass is what is still shallow or fused **after**
that work, plus the three items the first pass explicitly deferred.

## Vocabulary

Used exactly, throughout (`codebase-design`):

- **module** — anything with an interface and an implementation, at any scale.
- **interface** — everything a caller must know: the signature, but also
  invariants, ordering constraints, error modes and required configuration.
- **depth** — behaviour per unit of interface. A module is **deep** when a lot
  sits behind a small interface, **shallow** when the interface is nearly as
  complex as the implementation.
- **seam** — where behaviour can be altered without editing in that place.
- **adapter** — a concrete thing that satisfies an interface at a seam.
- **leverage** — what callers get from depth. **locality** — what maintainers
  get from it.

## The measured repetition

| Fact | Count | Fixed in |
|---|---|---|
| Sprite-session pool re-implemented in an asset workspace | 4 (~120–200 lines each) | 02 |
| `character-workspace.ts` — one component, ~90 members, 8 injected deps, no spec | 2,615 lines | 04 |
| `rAF + lastTick + accumulate` playback loop hand-rolled | 2 more, past `FlipbookClock` | 03 |
| `map-editor-page.ts` — one component, 13 injected deps, ~40 signals, no spec | 1,863 lines + 1,069 template | 05 |
| Hand-rolled clone of `DraftSet.save` (validate/write/reconcile/declare) | 1, in the map editor | 05 |
| `ControlDefinition` mutation rules copy-pasted | 3 screens, 4 call sites | 06 |
| Content-file picker (`files` / `refreshFiles` / `upload*`) | 4 copies (~40 lines each) | 06 |
| `EngineService` — fifth hand-kept copy of the seam method list | 671 lines, ~53 methods | 07 (spike) |
| `project.json` written by two modules under two rules | 2 (`DraftSet` vs `LocaleAuthoringService`) | 01 |

## The tickets

Issue files are numbered in **commit order**. Each is one branch, one PR, its
own smoke run. The card number is where the finding sits in
`/tmp/architecture-review-20260902-100235.html`.

| # | Card | Deepening | Strength | Blocked by |
|---|---|---|---|---|
| [01](issues/01-one-writer-for-project-json.md) | 6 | One writer for `project.json` | Strong | — |
| [02](issues/02-lift-the-sprite-session-pool.md) | 1 | Lift the sprite session pool out of the four workspaces | Strong | — |
| [03](issues/03-a-clock-over-an-animation.md) | 3 | A clock over an animation, not a flipbook | Worth exploring | — |
| [04](issues/04-break-up-the-character-workspace.md) | 2 | Break up the character workspace | Strong | 02, 03 |
| [05](issues/05-extract-the-world-save-pipeline.md) | 4 | Extract the world save pipeline; split the map inspectors | Strong | — |
| [06](issues/06-collapse-the-control-list-editor.md) | 7 | Collapse the control-list editor and the file-picker | Worth exploring | — |
| [07](issues/07-spike-generate-the-engine-service.md) | 5 | Spike: generate the engine service off the seam | Speculative | — |

## Order and why

**01 first.** Standalone, no dependencies, and it closes a latent bug rather
than a structural weakness: `LocaleAuthoringService.save()` writes `project.json`
from the manifest **as loaded**, where `DraftSet` writes it **as regenerated
from the open documents**. Saving languages while the map editor holds an
unwritten new map writes a manifest that omits it. The first pass flagged this
as "worth its own ticket" (05's comments). It is also where the smoke baseline
gets re-recorded if it is still stale at `ad25610` — 01 already expects one
moved screen on the `project.json` write path.

**Then 02** — the first pass's ticket 04 lifted the *editing session* into
`DraftSet`; the sprite pool underneath it was left copied in every workspace.
Highest leverage of the set: one interface, four adapters, ~600 duplicated
lines, and it is the prerequisite for 04.

**Then 03** — small, one caller (`character-workspace`; `play-page`'s loop is a
different abstraction), but it kills a hand-rolled accumulator and is the second
prerequisite for 04. The first pass named it in ticket 09: "a clock over
`Animation` rather than over `Flipbook`".

**Then 04** — the big one, and safe to spec once 02 and 03 have emptied it.
2,615 lines to roughly 900–1,100.

**Then 05** — independent of 02–04, can move earlier if wanted. The map editor's
save pipeline is a hand-rolled clone of `DraftSet.save` carrying five concerns
no adapter has (delete, multi-file write, cross-world link validation, engine
reset+re-register, zone materialisation). Not a `DraftSet` fit — its own tested
module.

**Then 06** — leaf cleanup. `control-list.ts` before 04, because two of its
three callers (settings, character-creation) have nothing to do with the
character workspace.

**Then 07** — a spike, last. The first pass's ticket 01 deferred generating
`EngineService` because its methods return typed values and marshal arguments —
"ticket 03's subject". Ticket 03 landed; the types are in `content/generated/`.
The deferral reason is gone. Whether the deepening is worth it is the spike's
question, with a written acceptance criterion.

## What is deliberately not proposed

- **`play-page`'s presentation clock.** It looks like the editor's playback loop
  but is a fixed-cadence "sample while entities are still gliding" ticker — no
  `timeMs`, no speed, no scrub — driven by the tick, not a play button
  (ADR-0003). A different abstraction. It stays in the page.
- **Splitting `crates/world/src/validation.rs`.** 5,637 lines, interface is 14
  functions of `(&Definition) -> ValidationReport`. Already deep. The first pass
  said the same.
- **Collapsing `hex-map-renderer.ts`.** 2,026 lines, 54 private methods, behind
  `setModel` / `draw` / `resolvePointer` with a 1,326-line spec. Deep-by-design,
  just big.
- **Forcing the map editor onto `DraftSet`.** Ticket 04's own risk clause:
  "if it doesn't fit, ticket it separately rather than bending `DraftSet`". Five
  extra concerns is not a fit. See 05.

## Guardrails for every ticket

- The project is pre-1.0 (`CLAUDE.md`): a breaking change is the preferred
  answer. No migration shims, no dual readers, no deprecation aliases. Every
  caller, test and document moves in the same change.
- A schema change bumps its `*_SCHEMA_VERSION` and is written down in
  `docs/content-format.md`. None of these seven changes a schema.
- ADR-0001, ADR-0010, ADR-0011, ADR-0012 are not reopened. Where a ticket
  touches an ADR's subject (04 → ADR-0025/0028, 05 → ADR-0014/0018) it says so
  in the commit and says why the decision survives. The one ADR edit any of
  these may make is an amendment to ADR-0010, and only if 07's spike fails.
- New `app/editing/` modules (02, 03) are covered by ticket 04's existing
  amendment to ADR-0015; no new ADR.
- `npm run check` and the `verify-no-regression` smoke run pass before the work
  is called done. `npm run build` too, after any type change — `check` misses
  Angular templates.
- Each push carries a patch or minor bump via the `commit-and-push` skill.

## The settled design

Every decision below was reached by grilling and is not to be re-litigated by
the implementer. It is repeated in each issue file next to the work it governs.

### 01 — one writer for `project.json`

- **Routing-only.** `LocaleAuthoringService` takes the `DraftLedger` port (or
  injects `WriteLedger`) and calls `projectJson()` / `markManifestWritten()`.
  No new module — `WriteLedger` already owns the regenerated manifest.

### 02 — the sprite session pool

- **`app/editing/sprite-sessions.ts`**, editor-only. Constructor takes a port
  `{ load(path): Promise<…>, write(path, blob): Promise<void> }`. The module
  builds `SpriteDocument` from what `load` returns (option A); `SpriteDocument`
  keeps its own undo history.
- **Scoped to the open draft**, not keyed globally. Constructed per `DraftSet`
  (or takes the open-draft id); `unsaved` / `write()` answer only over the
  sprites the open draft owns, whose path set the adapter supplies via
  `dirtySprites(draft)`. This bakes in ticket 09's finding.
- **Interface is collection verbs only**: `open(path)`, `discard(path)`,
  `write()`, `unsaved`, `get(path): SpriteDocument`. "Frame" / "image" /
  "variant" is kind-specific vocabulary the adapter maps to paths; the module
  never learns what a frame is.
- **All four workspaces move**, tile included — ticket 09's `assetsOf(openSet)`
  / `unwritten(set)` becomes the module's scope logic, not a fourth private
  copy.
- `SpriteDocument.unsaved` stays on the document; the module aggregates it.

### 03 — the animation clock

- **`app/editing/animation-clock.ts`**, sibling of `flipbook-clock.ts`. Shares
  only the injected `Ticker` type — no `ScrubClock` base class.
- **Interface**: `timeMs` (signal), `playing` (signal), `speed` (signal),
  `togglePlay()`, `setSpeed(n)`, `scrubTo(ms)`, a `bounds` signal input
  `{ durationMs, loop }`, injected `Ticker`. Starts paused at `timeMs = 0`.
- The clock owns self-stop at the end of a non-looping animation — it reads
  `bounds`, so it stays correct when the author switches the selected animation
  without a re-`play()`.
- One caller: `character-workspace`. `play-page` is not a caller.

### 04 — break up the character workspace

- **`renderer/character-stage.ts`**, framework-free, `CanvasRenderingContext2D`
  in the constructor, `setModel(model)` / `draw()` — the `hex-map-renderer`
  shape. Its own model type, not a `render-model` member.
- **The stage draws the editor chrome.** The model carries an options bag
  `{ showSkeleton, showGrid, showTransparency, canvasBounds, openLayerId }` and
  the stage draws all of it — `strokeSkeleton`, `strokeGrid`,
  `paintTransparency`, `strokeCanvasBounds`, `strokeOpenLayer`. If chrome stays
  in the page the extraction is cosmetic.
- **Pointer mapping is the stage's**: `stage.pixelAt(clientX, clientY)`,
  `stage.nodeAt(...)`. It owns the transform.
- **Three callers**: `character-workspace` plus both character-creation preview
  panes (`character-creation-editor-page.ts`,
  `character-creation-page.ts`) — which folds their uncapped-DPR inconsistency
  into `canvas-surface` where the other panes already resolved it. The creation
  panes pass a model with every chrome option off.
- Also leaves the workspace: the clock (03) and the sprite pool (02).
- **What stays** (~900–1,100 lines): the `DraftSet` wiring, the
  `CharacterAnimator` child hookup, the ~30 layer/variant/parameter/anchor CRUD
  wrappers over `edit(mutate)`, the template.
- **No new spec on the page.** `CharacterStage` gets a spec in the
  `hex-map-renderer.spec.ts` style.

### 05 — the world save pipeline

- **`app/project/world-save-pipeline.ts`**, a plain class (signals, no
  `inject()`), constructor-injected deps — the `DraftSet` bargain, so it specs
  without `TestBed`.
- It **orchestrates a sequence** and is not a new home for manifest fields:
  write changed worlds → reconcile the manifest (with deletion of renamed /
  removed maps) → materialise the implicit default zone **via `WriteLedger`**
  (ADR-0018) → validate links across the loaded set (ADR-0014) after an engine
  reset + full re-register. It reuses `WriteLedger`
  (`changedWorldIds`, `orphanedWorlds`, `markWorldWritten` / `markWorldDeleted`),
  `ContentLibrary`, `engine.validateLinks`.
- **The three inspectors become child components first**, as their own
  commit(s): `<placement-inspector>`, `<link-inspector>`, `<zone-inspector>`,
  each taking its slice of the world as `input()` and emitting a new slice as
  `output()` — the `CharacterAnimator` shape, draw nothing. The page applies the
  slice through `WorldDocument`'s existing mutators. Land these before the
  pipeline extraction; they shrink the file and the 1,069-line template first.
- `WorldDocument` (deep, spec'd, packed buffers) is untouched. Brush-stroke
  editing stays in the page.
- The `ProjectRegistration` helper for the `registerContent` /
  `resetEngineContent` pair (play-page + map-editor-page) rides along **only if
  cheap**; drop it otherwise.

### 06 — the control-list editor and the file-picker

- **`app/settings/control-list.ts`**, pure, next to `defaultFor` / `isNumeric`
  / `usesOptions`. Interface: `setControlKind`, `addOption`, `renameOption`,
  `removeOption`, each taking a `ControlDefinition` and returning a new one —
  the mutation rules (switch kind resets `default`, rename carries the default,
  first `select` option becomes the default) live once. The three screens
  (settings, character-creation ×2, character-workspace) call it inside
  `edit()`.
- **Its own branch, before 04.**
- **The content-file picker** folds into a **separate `WorkspaceFiles` port**
  (`listFiles(dir)`, `upload(file, dir)`), not into `DraftWriter` — `DraftSet`
  never lists or uploads. The four asset workspaces take `WorkspaceFiles`
  directly and expose a shared `images()` / `assets()` / `tracks()` computed
  off it.

### 07 — spike: generate the engine service

- **A throwaway branch.** Add marshalling descriptors to `seam.json` for five
  methods spanning the hard cases and generate those into `engine.service.ts`:
  `loadWorld` (trivial), `resolveCharacter` (pose object split into `animation`
  + clamped `timeMs`, default `values`), `previewTileRender` (default params +
  `JSON.stringify(choice)`), `createGame` (`JSON.stringify` + the
  `this.running` mirror after the call), `terrainBuffer` (the `this.call`
  non-parse bytes path).
- **Commit only if both hold**: (1) each method's `seam.json` addition is
  structured data — a marshalling descriptor — not a code snippet embedded in a
  JSON string; (2) a reader can still tell what `EngineService` does for a given
  method without opening the generator.
- **If either fails**: `EngineService` stays hand-written and keeps the
  `unwiredMethods` guard. Record the permanent deferral as an amendment to
  ADR-0010. The spike branch is deleted.

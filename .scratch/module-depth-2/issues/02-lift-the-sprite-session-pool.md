# 02 — Lift the sprite session pool out of the four workspaces

Status: ready-for-agent
Strength: strong
Blocked by: —
Card: 1

**Top recommendation.** Highest leverage of the set, and the prerequisite for
04: the character workspace cannot get a meaningful spec while the pool is fused
into it.

## Problem

The first pass's ticket 04 lifted the *editing session* into `DraftSet`. The
sprite pool underneath it was left copied in all four asset workspaces.

```
character-workspace.ts   ~200 lines of pool
decoration-workspace.ts  ~180
object-workspace.ts      ~130
tile-workspace.ts        ~120   (its own, from ticket 09)
```

Each holds its own `Map<string, SpriteDocument>`, a decode-once
`opening` / `requested` guard, a private `loadImage()` free function,
`writeSprites()`, an `unsavedSprites` / `unwritten` computed, a `sprite`
computed, `touchSprites()`, `createFrame` / `createImage`, `uploadFrame`,
`frameMissing` / `assetMissing`, `forgetFrames` / `forgetImage`. Near-verbatim.
None of the four workspaces has a spec; this cluster is reachable only through a
`TestBed`.

`DraftSource.dirtySprites` / `writeSprites` already exist as the hooks — each
adapter reimplements the pool behind them.

Deletion test: delete the pool and it reappears in four callers. It earns a
module.

## Deepening

One framework-free `SpriteSessions` module behind the draft source. Each adapter
delegates `dirtySprites` / `writeSprites` to it instead of reimplementing.

The shape is proven three times in this repo: `ContentLibrary`, `DraftSet`,
`canvas-surface`.

## Decisions

- **`app/editing/sprite-sessions.ts`**, editor-only (ADR-0015's amendment from
  ticket 04 covers it). Uses `signal()` / `computed()`, never `inject()` — it
  specs without `TestBed`.
- **Constructor port**: `{ load(path): Promise<…>, write(path, blob): Promise<void> }`.
  The module builds `SpriteDocument` from what `load` returns (option A) — the
  document is uniform (resolution + decoded pixels), only the bytes are
  kind-specific and that is what the port abstracts.
- **`SpriteDocument` keeps its own undo history** (`CONTEXT.md`). The module
  owns the collection, the unsaved aggregation and the batch write, nothing
  else.
- **Scoped to the open draft.** Constructed per `DraftSet` (or takes the
  open-draft id). `unsaved` and `write()` answer only over the sprites the open
  draft owns; the adapter supplies that path set via `dirtySprites(draft)`.
  This bakes in ticket 09's finding ("one scope for every question about
  pixels") — the object editor's looser answer, which wrote a sibling draft's
  PNG on save, is not an option the shared module offers.
- **Interface is collection verbs only**: `open(path)`, `discard(path)`,
  `write()`, `unsaved`, `get(path): SpriteDocument`. "Frame" / "image" /
  "variant" is kind-specific vocabulary — the adapter maps it to paths; the
  module never learns what a frame is.
- **All four workspaces move, tile included.** Ticket 09's `assetsOf(openSet)` /
  `unwritten(set)` becomes the module's scope logic, not a fourth private copy
  of it. Tile's adapter supplies its path set like the other three.
- **`SpriteDocument.unsaved` stays on the document**; `SpriteSessions`
  aggregates it into its own `unsaved`, so there is one answer to "is a sprite
  unwritten", not two.

## Done when

- [ ] One module owns the sprite cache, the unsaved set and the batch write.
- [ ] The four workspaces hold no `Map<string, SpriteDocument>`, no
      `loadImage()`, no `writeSprites()` of their own.
- [ ] `sprite-sessions.spec.ts` runs with no DOM and no `TestBed` — first
      coverage this cluster has had.
- [ ] The per-draft scope is pinned by a test: saving draft A does not write
      draft B's images.
- [ ] `npm run check` and the smoke run pass, screenshots unchanged.

# 05 — Extract the world save pipeline; split the map inspectors

Status: ready-for-agent
Strength: strong
Blocked by: —
Card: 4

Independent of 02–04. Can move earlier in the program if wanted.

## Problem

`apps/web/src/app/features/editor/map/map-editor-page.ts` is 1,863 lines with a
1,069-line template, 13 injected dependencies, ~40 signals / computeds and **no
spec**. It fuses:

- **camera + viewport** *(stays)*
- **tool / dock / inspector routing** *(stays)*
- **a decoration-placement inspector** (472–596)
- **a link inspector** + `validateLinks` (986–1037, 1044)
- **zone management** (304–326, 1152–1182, `syncZoneFilter` 1679)
- **a save / validate / reconcile pipeline** — `saveWorld` / `saveProject` /
  `reconcileManifest` / `validateProject` / `write` (1321–1485) — a hand-rolled
  clone of `DraftSet.save`

The pipeline carries five concerns none of the seven `DraftSet` adapters has:

1. **manifest reconciliation with deletion** — `reconcileManifest()` deletes the
   files of maps removed or renamed. No adapter deletes; `DraftSet` only
   appends.
2. **writing many files in one action** — `saveProject()` loops
   `ledger.changedWorldIds()`. `DraftSet.save()` writes only the open draft.
3. **cross-world link validation (ADR-0014)** — registers every world into the
   engine, then `engine.validateLinks()` over the whole set.
4. **engine content reset + full re-register before validate** — a world is
   validated against its tile set (ADR-0026), so the registry is cleared and
   re-added first.
5. **zone materialisation (ADR-0018)** — a world's `zone` field is manifest
   state the editor mutates directly.

## Deepening

Do **not** force this onto `DraftSet`. Ticket 04's own risk clause:
"if it doesn't fit, ticket it separately rather than bending `DraftSet`."

Two moves:

- Split the three inspectors into child components — safe, mechanical, first.
- Extract the pipeline into its own tested module — the risk, second.

## Decisions

### The inspectors — first, their own commit(s)

- `<placement-inspector>`, `<link-inspector>`, `<zone-inspector>`, the
  `CharacterAnimator` shape: **draw nothing**. Each takes its slice of the world
  as `input()` (the placements / the links / the zones) and emits a new slice as
  `output()`.
- The page applies the slice through `WorldDocument`'s existing mutators.
  Placements, links and zones are structured lists, not the packed buffers
  `WorldDocument` exists to guard — keeping the inspectors a slice-in /
  slice-out function is what makes them testable without the map canvas.
- Land these before the pipeline extraction: they shrink the file and the
  1,069-line template first, so the pipeline diff reviews against a smaller
  file.

### The pipeline — `app/project/world-save-pipeline.ts`

- **A plain class** (uses `signal()` / `computed()`, never `inject()`),
  constructor-injected deps — the `DraftSet` bargain, so it specs without
  `TestBed`.
- It **orchestrates a sequence** and is not a new home for manifest fields:
  write changed worlds → reconcile the manifest (with deletion) → materialise
  the implicit default zone **via `WriteLedger`** → validate links across the
  loaded set after an engine reset + full re-register.
- It **reuses** `WriteLedger` (`changedWorldIds`, `orphanedWorlds`,
  `markWorldWritten` / `markWorldDeleted`), `ContentLibrary`,
  `engine.validateLinks`. Zone state stays where ticket 05 (first pass) put it —
  the pipeline calls into `WriteLedger`, it does not own zone fields.
- `WorldDocument` is untouched. Brush-stroke editing stays in the page.

### Riding along, only if cheap

- A `ProjectRegistration` helper for the `registerContent` (play-page.ts:333) /
  `resetEngineContent` + `loadProjectIntoEngine` (map-editor-page.ts:1525)
  pair — the same "reset the engine, re-register the whole project" sequence in
  two places. If it is a clean 30-line extraction, take it here; otherwise drop
  it, it is not this ticket's point.

## ADR note

ADR-0014 (map links) and ADR-0018 (map zones) are cited in the commit: the
pipeline moves the code that implements them into a tested module, it does not
change either decision. ADR-0018 has no textual citation in
`map-editor-page.ts` today though the zone code is its surface — add one.

## Done when

- [ ] `map-editor-page.ts` holds no `saveWorld` / `reconcileManifest` /
      `validateProject` of its own.
- [ ] The three inspectors are child components with `input()` / `output()` and
      a spec each that runs without the map canvas.
- [ ] `world-save-pipeline.ts` has a spec that runs without a `TestBed`,
      covering: a renamed map's old file is deleted, several changed worlds are
      all written, link validation runs against the re-registered set, the
      default zone is materialised on a project that declares none.
- [ ] `npm run check`, `npm run build` and the smoke run pass, screenshots
      unchanged.

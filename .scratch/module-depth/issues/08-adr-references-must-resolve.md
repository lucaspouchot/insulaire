# 08 — ADR references must resolve, and be checkable

Status: done
Strength: strong
Blocked by: —

**Done first**, before 04. It is the only ticket here that fixes something
currently wrong rather than something structurally weak, and tickets 01–07 will
each add ADR citations to code and docs.

## Problem

`.claude/rules/specs.md` requires decisions to be cited by path
"so the reference stays greppable and can be checked to still resolve".
`.claude/commands/create-adr.md` step 4 of *Folding one ADR into another* says:

> Verify that no `ADR-NNNN` anywhere in the repository fails to resolve.

The instruction is right. It is also **unenforceable by the means available**: a
citation wrapped across two comment lines is invisible to `grep`. Commit
`8f8d582` consolidated 51 ADRs into 36 and renumbered them; every citation that
survived on one line was updated, and every citation that had wrapped was not.

### Three stale references, in committed source

```
apps/web/src/content/sprite-document.ts:5
  ADR-0029-characters-are-composed-sprites.md      → no such file
  ADR-0029 is now character-creation-is-a-generic-authored-workflow

apps/web/src/app/features/editor/asset/pixel-editor.ts:5
  ADR-0030-the-editor-paints-its-sprites.md        → no such file
  ADR-0030 is now gameplay-selects-character-animations-by-role

crates/world/src/tileset.rs:19
  ADR-0037-a-flat-map-is-drawn-from-flat-art.md    → no such file
  there is no ADR-0037; the corpus ends at 0036
```

All three wrapped. None is reachable by the check the rule promises.

### Two citations the fold collapsed incorrectly

```
apps/web/src/app/features/editor/asset/character-editor.types.ts:8
  cites ADR-0024-character-definitions.md twice in one parenthesis

apps/web/src/content/sprite-document.ts:171
  reads "ADR-0028-one-editor-for-everything-drawn.md, amending
  ADR-0028-one-editor-for-everything-drawn.md" — a file amending itself
```

Both are what step 3 of the fold procedure calls "collapse any duplicate
reference", not done — again, because one half of each pair had wrapped.

### Where each stale citation should point

| Site | Now cites | Should cite | Why |
|---|---|---|---|
| `sprite-document.ts:5` | 0029 *composed sprites* | **ADR-0024** character definitions | "`layers` are the pieces it is drawn from […] A layer draws a sprite, and that is all it can draw […] A definition declares its canvas — `resolution`" |
| `pixel-editor.ts:5` | 0030 *editor paints its sprites* | **ADR-0028** one editor for everything drawn | "pencil, eraser, eyedropper, a palette ranked by use, undo […] the same bounded undo, the same palette arithmetic" |
| `tileset.rs:19` | 0037 *flat map from flat art* | **ADR-0026** tile art authored and resolved by level | "A tile carries `art`: flat variants, surface variants […] draws `flat` alone and shows no relief" |

Schema versions 2 and 3 of the tile set both trace to ADR-0026 after the
consolidation. That is true, and the comment should say so plainly rather than
citing the same file twice.

## The fix, in three parts

**1. Correct the five sites** above.

**2. `scripts/check-adr-references.mjs`, run by `npm run check`.** Three
assertions:

- every `ADR-NNNN-<slug>.md` path in the repository resolves to a file in
  `docs/adr/` — after joining citations broken across comment lines, which is
  the case `grep` cannot see;
- every bare `ADR-NNNN` mention resolves to an existing number
  (`crates/world/src/tileset.rs` also says "ADR-0037" with no path, which no
  path-based check would catch);
- the **Architecture decisions** list in `README.md` matches the corpus exactly —
  `create-adr` says that list "is the index, and it is the only one", so a
  missing entry and a ghost entry are both defects.

Generated and ignored output is skipped: `apps/web/public/wasm/`,
`apps/web/dist/`, `target/`, `node_modules/`. Those carry stale citations from
Rust doc comments captured before the renumbering and regenerate on the next
build.

**3. A house-style rule in `.claude/commands/create-adr.md`.** A citation never
wraps. Every ADR path in this corpus fits inside 80 columns when it begins a
line, so the rule costs nothing. Without it the checker fights the comment
wrapper forever, and the next renumbering leaves the same residue.

## What this does not change

No ADR's content changes. This is a reference-integrity fix and a check; the
decisions themselves are untouched.

## Done when

- The five sites are correct.
- `node scripts/check-adr-references.mjs` passes, and fails when a reference is
  broken — proved by `scripts/check-adr-references.test.mjs`.
- `npm run check` runs it.
- `create-adr` states the no-wrap rule.

## Comments

**Done.** `npm run check` gate passes, exit 0.

Five sites corrected:

| Site | Was | Now |
|---|---|---|
| `apps/web/src/content/sprite-document.ts:5` | ADR-0029 *characters-are-composed-sprites* | ADR-0024 character definitions |
| `apps/web/src/app/features/editor/asset/pixel-editor.ts:5` | ADR-0030 *the-editor-paints-its-sprites* | ADR-0028 one editor for everything drawn |
| `crates/world/src/tileset.rs:19` | ADR-0037 *a-flat-map-is-drawn-from-flat-art* | ADR-0026 tile art authored and resolved by level |
| `apps/web/src/app/features/editor/asset/character-editor.types.ts:8` | ADR-0024 twice | once |
| `apps/web/src/content/sprite-document.ts:171` | ADR-0028 "amending" itself | once |

Added:

- `scripts/adr-references.mjs` — the rules, kept apart from the runner so they
  are testable directly, following `content-paths.mjs`.
- `scripts/check-adr-references.mjs` — walks the tree, reports. Skips generated
  output and `.scratch/`.
- `scripts/adr-references.test.mjs` — 11 tests, including the regression test for
  the exact wrapped-and-stale shape that survived `8f8d582`.
- `npm run check:adr`, first step of `npm run check`.
- The **A citation never wraps** rule in `.claude/commands/create-adr.md`, and
  step 4 of *Folding one ADR into another* now names the command instead of
  asking for a manual check.
- README: the command table, and `test:scripts`' description.

Three decisions worth recording, none of which was in the ticket:

1. **Ranges are a citation shape.** `docs/architecture.md:69` says
   `(ADR-0024..0034)`. Both endpoints are checked.
2. **The README index is checked both ways, and by title.** A number missing, a
   ghost entry, and an index title that disagrees with the ADR's own heading are
   all defects. This catches "renumbered the file, forgot the index".
3. **One narrow exemption, and it is visible.** The checker's own test must hold
   broken citations. A file declaring `@adr-fixtures` is skipped, and every run
   names what it skipped — `[adr] 2206 file(s) checked against 36 decision(s),
   scripts/adr-references.test.mjs exempt`. An exemption that hides is an
   exemption that rots.

Verified end to end on the real tree: reintroducing the wrapped ADR-0037
citation in `tileset.rs` is found by `npm run check:adr` and **not** found by
`grep -c "ADR-0037-a-flat-map-is-drawn-from-flat-art.md"`, which returns 0. That
is the gap the ticket existed to close.

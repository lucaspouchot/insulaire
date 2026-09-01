# Module depth: seven deepenings

Findings from an architecture review of `main` at `2680070` (2026-08-30). The
subject is **depth** — how much behaviour sits behind an interface — not
features. Nothing here changes what the game does *on purpose*.

That is not the same as "no screen may move". Several of these tickets replace
N copies of one job with one module, and copies drift: where they had, the
screens that were wrong are the ones that change, and the smoke run showing it
is the work being confirmed rather than a regression. A consolidation that left
every screen pixel-identical would more likely mean nothing was really shared.
The bar is that each moved pixel is *explained by the consolidation* and lands
on the copy that was wrong — see `## 6` of
`.claude/skills/verify-no-regression/SKILL.md`.

## Vocabulary

Used exactly, throughout these tickets:

- **module** — anything with an interface and an implementation, at any scale.
- **interface** — everything a caller must know: the signature, but also
  invariants, ordering constraints, error modes and required configuration.
- **depth** — behaviour per unit of interface. A module is **deep** when a lot
  sits behind a small interface, **shallow** when the interface is nearly as
  complex as the implementation.
- **seam** — where behaviour can be altered without editing in that place.
- **leverage** — what callers get from depth. **locality** — what maintainers
  get from it.

## Why now

The last substantive change, `9aaf9d2` ("add decorations and objects"), cost
**64 files and 10,929 lines** for two content kinds. 1,063 of those lines were
pure forwarding, written before a single rule was. The next kinds — scenario and
combat — are already in the planned repository layout. The forwarding is what
these tickets remove.

## The measured repetition

| Fact | Count |
|---|---|
| Engine method list, written by hand | 5 times (54 / 54 / 55 / 55 / 53) + a 952-line reference doc *(fixed in 01)* |
| Content kinds threaded through the stack | 9 *(fixed in 02)* |
| TypeScript types mirroring Rust definitions | 85, with 1 assertion checking a pair *(fixed in 03)* |
| Asset workspace lines with no spec | 6,303 |
| Editor modules with no spec | 15 of 17 |
| `ProjectStoreService` public members | 55, across 6 concerns |
| Stale ADR citations, all hidden by line wrapping | 3 (fixed in 08) |

## The tickets

| # | Deepening | Strength |
|---|---|---|
| [01](issues/01-declare-the-engine-seam-once.md) | Declare the engine seam once | Strong · **done** |
| [02](issues/02-content-kind-is-a-module.md) | Make the content kind a module | Strong · **done** |
| [03](issues/03-derive-content-types-from-definitions.md) | Derive the content types from the definitions | Strong · **done** |
| [04](issues/04-one-editing-session-for-the-workspaces.md) | Give the asset workspaces one editing session | Strong · **done** |
| [05](issues/05-close-the-project-store-read-side.md) | Close the project store's read side | Strong · **done** |
| [06](issues/06-one-canonical-writer.md) | One canonical writer, not seven | Worth exploring |
| [07](issues/07-lift-the-session-presentation.md) | Lift the session presentation out of the play page | Worth exploring |
| [08](issues/08-adr-references-must-resolve.md) | ADR references must resolve, and be checkable | Strong · **done** |
| [09](issues/09-tile-and-locale-do-not-fit-the-draft-set.md) | Tile and locale do not fit the draft set | Strong · split out of 04 · **done** |

## Order

**08 first, and done.** It was an afternoon, it fixes something currently
wrong rather than structurally weak, and it guards every ADR citation the other
seven will write — 02 and 03 especially, since they touch every content kind.

**Then 04, and done** — except for the two screens [09](issues/09-tile-and-locale-do-not-fit-the-draft-set.md)
carries. It was the only one where the cost had already been paid: the four
copies had drifted, and three preview panes rendered at three different
resolutions on the same screen. It was the largest untested surface in the
repository, it stayed inside one language, and the interface did not need
designing — `ContentLibrary` and `HexMapRenderer` both demonstrated the shape
already. Its design was settled; see `## Decisions` in the ticket, and 04a–04f
for the commit order.

**Then 09's first half**, which is a line in this spec and no code: the locale
adapter 04 proposed does not survive contact with `locale-editor-page.ts`, and
the row should go. Its second half waits on 05.

**Then 05, and done** — five modules under `app/project/`, no forwarding, 22
caller files moved. It gives 02 somewhere to land and unblocks 09's tile half.

**Then 09's second half, and done.** `tile-workspace.ts` is the seventh adapter:
the draft is the *set*, its list is `TileSetLibrary`'s — read in eagerly, which
is what 05 made possible — and its thirty mutate-then-touch sites are
`edit(mutate)`. It was for tile's own sake rather than to evidence the seam: one
definition of unsaved, and six pure functions moved into `tile-editor.types.ts`
where a spec reaches them without a canvas.

**Then 01, and done** — taken before 02 rather than out of it, on the ticket's
own note that "doing 01 first makes 02 smaller". One declaration,
`crates/engine/seam.json`, and a generator for the four copies; `EngineService`
stays hand-written but can no longer fall behind it. 02 now adds a kind to a
list instead of to five.

**Then 02, and done.** A `ContentKind` trait for what a kind does, a
`content_kinds!` macro for the list of them, and a `kind` row in `seam.json`
that expands into the boundary methods that kind has. Only two of the four
operations the ticket proposed generalise — `resolve` and `preview` take
different arguments per kind, which is what makes a kind that kind — and the
locale file turned out not to be a kind at all, for the reasons 09 found on the
Angular side. `ContentRegistry` went from 48 public members to 18, none of them
per-kind; `seam.json` from 25 per-kind rows to 9. No rule moved.

**Then 03, and done.** `ts-rs` derives the 86 shapes from the definition structs
and `crates/world/src/ts_export.rs` publishes the 41 bounds with the values the
compiler resolved; `content-types.ts` is gone and its 78 callers import from the
nine schema modules. Nothing parses Rust, which is what made the answer to the
ticket's first open question decide the other two. It found three disagreements
the hand-kept file had been hiding, one of them a live bug — `CreationBlock::Text`
asked for `text_key` while every other side said `textKey` — and it cost 1,401
bytes of WASM, 0.18%.

Then **06**: the default table it needs is the fact 03 now generates. **07** is
independent and can go at any point.

## What is deliberately not proposed

- **Collapsing the hex maths.** `crates/world/src/hex.rs` and
  `apps/web/src/core/hex/hex-coords.ts` implement offset↔axial twice on purpose.
  ADR-0011 decided it, names the drift risk, and mitigates it with mirrored test
  suites. Rendering cannot afford a WASM call per hex.
- **Splitting `validation.rs`.** 5,637 lines, but its interface is 14 functions
  of `(&Definition) -> ValidationReport`. That is already deep; moving it into
  files changes nothing a caller sees.
- **`app-strings.ts`.** 2,298 lines and top of the churn list, but big because it
  is data. Not shallow.

## Guardrails for every ticket

- The project is pre-1.0 (`CLAUDE.md`): a breaking change is the preferred
  answer. No migration shims, no dual readers, no deprecation aliases. Every
  caller, test and document moves in the same change.
- A schema change bumps its `*_SCHEMA_VERSION` and is written down in
  `docs/content-format.md`.
- ADR-0001, ADR-0010, ADR-0011 and ADR-0012 are not reopened by any of these.
  Where a ticket touches an ADR's subject, it says so and says why the decision
  survives.
- `npm run check` and the `verify-no-regression` smoke run pass before the work
  is called done.

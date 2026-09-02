# 06 — Collapse the control-list editor and the file-picker

Status: ready-for-agent
Strength: worth exploring
Blocked by: —
Card: 7

Leaf-duplication cleanup. `control-list.ts` lands **before 04**, because two of
its three callers have nothing to do with the character workspace.

## Problem — two clusters

### The `ControlDefinition` list-editor, triplicated

- `settings-editor-page.ts:391-518`
- `character-creation-editor-page.ts:383-505` — two parallel copies in one file,
  choices and characteristics
- `character-workspace.ts:999-1145`

The mutation rules are copy-pasted: switching control kind resets `default`,
renaming an option carries the default, the first `select` option becomes the
default. All three already import `defaultFor` / `isNumeric` / `usesOptions`.
Only the `*.types.ts` halves are tested; the mutation logic is DOM-only.

### The content-file picker, ×4

- `object-workspace.ts:106-108,293-302,558-581`
- `decoration-workspace.ts:203-204,487-496,828-851`
- `character-workspace.ts:238-239`
- `title-editor-page.ts:92-93,168-173,245-270`

~40 lines each: a `files` signal, a `refreshFiles()` guarded on
`workspace.status()`, an extension-filtered `images` / `assets` / `tracks`
computed, an `upload*()` that writes then refreshes then announces.

## Deepening

Both are leaf clusters that already have a home — one a pure module, the other
an existing port.

## Decisions

- **`app/settings/control-list.ts`**, pure, next to `defaultFor` / `isNumeric` /
  `usesOptions`. Interface: `setControlKind(control, kind)`,
  `addOption(control)`, `renameOption(control, i, value)`,
  `removeOption(control, i)` — each takes a `ControlDefinition` and returns a
  new one. The three screens call it inside `edit()`.
- **Its own branch, before 04.**
- **The file-picker folds into a separate `WorkspaceFiles` port**
  (`listFiles(dir)`, `upload(file, dir)`), **not** into `DraftWriter` —
  `DraftSet` never lists or uploads files, so widening the session seam would
  put members on it that the session does not use. The four asset workspaces
  and `title-editor-page` take `WorkspaceFiles` directly and expose one shared
  `images()` / `assets()` / `tracks()` computed off it.
- `ContentWorkspaceService` is the real implementation behind the port (it
  already has the directory listing); the port is the little of it a screen
  uses.

## Done when

- [ ] `control-list.ts` owns the three mutation rules; the four call sites are
      one line each.
- [ ] `control-list.spec.ts` covers the rules with no Angular.
- [ ] No screen holds its own `files` / `refreshFiles` / `upload*`; they take
      `WorkspaceFiles`.
- [ ] `npm run check` and the smoke run pass, screenshots unchanged.

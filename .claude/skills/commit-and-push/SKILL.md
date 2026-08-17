---
description: Commit the verified working tree and push it — review the diff, check the docs/ADRs that the change owes, write the message in this repo's style, push to origin and report the SHA.
name: commit-and-push
---

# Commit and push

Turns a verified working tree into one pushed commit. It assumes the change is
already **proven**, and its first job is to refuse to bury an unproven one.

## 1. Refuse to commit unverified work

The [verify-no-regression](../verify-no-regression/SKILL.md) skill must have run
on the current state of the tree and come back clean.

- Not run yet, or files changed since → run it now.
- Gates failing, or verdict `regression` → **stop**. Report what is red and
  what would have to change. Do not commit "to save the work" unless the user
  says so explicitly, and then say in the commit message that it is red.
- `verdict: no-baseline` → acceptable, but say so: this commit was not compared
  with anything.

## 2. Review what is about to be committed

```bash
git status --short
git diff            # unstaged
git diff --cached   # already staged, if any
```

Read the whole diff, and check:

- **Nothing incidental**: no `.smoke/`, `deliveries/`, `dist/`, `target/`,
  `public/wasm/`, `public/content/` (all gitignored — if one shows up, the
  ignore rules are wrong, fix them instead of committing the file).
- **No leftovers**: `console.log`, `dbg!`, `todo!()`, commented-out blocks,
  `it.only` / `#[ignore]`, hardcoded local paths, a seed or port switched for a
  one-off test.
- **No secrets**: tokens, keys, absolute home paths.
- **Only this change**: unrelated files that happen to be dirty do not belong in
  this commit. Leave them, and say you left them.

## 3. Pay what the change owes

Per `CLAUDE.md`, a change that moves an architectural decision does not ship
alone:

- Architecture decision changed or added → an ADR in `docs/adr/` (skill:
  `create-adr`), and the ADRs it supersedes updated.
- User-visible behaviour changed → the specs, per `maintain-project-specs`.
- Engine boundary changed → `docs/wasm-api.md` and `apps/web/src/engine/engine.types.ts`.
- Content schema changed → `docs/content-format.md` and the files under `content/`.
- New scenario-worthy feature → a step or page in the smoke scenario.

If one of these is missing, write it before committing rather than after.

## 4. Stage deliberately

```bash
git add <path> [<path> …]
```

Path by path — never `git add -A`. Then confirm with `git status --short` that
what is staged is exactly what you reviewed.

## 5. Write the message in this repo's style

Look at `git log --oneline -10` first. The convention here is short, lowercase,
imperative subjects — `add isometric view`, `fix raise and down tile`, `use
tauri to package as a standalone app`.

- Subject: imperative, lowercase, ≤ 60 characters, no trailing period, no
  `feat:`/`chore:` prefixes.
- Body (only when the subject cannot carry it): wrapped at 72 columns, saying
  **why**, not what the diff already shows. Reference the ADR or the doc the
  change follows: `docs/adr/ADR-0017-map-links.md`.
- One commit = one coherent change. Two unrelated changes are two commits.
- End the message with the trailer:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

```bash
git commit -m "$(cat <<'EOF'
paint elevation with the raise tool

The tool wrote the terrain index instead of the elevation byte, so a raised
hex rendered flat (docs/adr/ADR-0016-isometric-projection.md).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

## 6. Push

This project is trunk-based: `main` is the branch, and it is what `origin`
tracks. Push the current branch as it is — create a branch and a PR only when
the user asks for one, or when the change is large enough that they said they
want to review it first.

```bash
git push
```

- No upstream yet → `git push -u origin <branch>`.
- Rejected as non-fast-forward → `git pull --rebase`, then re-run
  `verify-no-regression` if the rebase brought in other people's commits, then
  push again.
- **Never** `--force` / `--force-with-lease` on `main`, and never rewrite a
  commit that is already on `origin`, unless the user explicitly asks.
- Hooks or CI reject the push → report the reason; do not work around it.

## 7. Report

```
verified   npm run check passed · smoke verdict clean
commit     0e9e783 paint elevation with the raise tool
files      3 changed (crates/world/src/definition.rs, apps/web/src/…, docs/…)
pushed     origin/main → git@github.com:lucaspouchot/insulaire.git
left out   apps/web/src/styles.css (unrelated local edit)
```

Confirm afterwards with `git status --short` (clean or only the files you
deliberately left) and `git log --oneline -1`.

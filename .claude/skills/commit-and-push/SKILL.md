---
description: Commit the verified working tree and push it — review the diff, check the docs/ADRs that the change owes, bump the patch or minor version when shipped code changed, write the message in this repo's style, push to origin and report the SHA.
name: commit-and-push
---

# Commit and push

Turns a verified working tree into a pushed commit — plus a version bump when
shipped code moved. It assumes the change is already **proven**, and its first
job is to refuse to bury an unproven one.

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

## 4. Bump the version

**A push that changes shipped code carries a version bump.** The unit is the
push, not the commit: one bump covers everything going out, however many commits
that is.

### Does this push need one?

```bash
git diff --name-only @{u}...HEAD      # everything since the last push
```

Nothing tracked outside this list changed → **no bump**, say so and move on:

- `docs/**`, `README.md`, `CLAUDE.md`, `LICENSE`
- `.claude/**` — skills, commands, rules, the smoke scenario

Anything else — `crates/**`, `apps/**`, `content/**`, `scripts/**`, the
manifests — is shipped code, and the push gets a bump.

### patch or minor?

Read the diff, not the commit subjects. When both apply, the higher wins.

| | Bump | The push… |
|---|---|---|
| **minor** | `0.1.0` → `0.2.0` | adds or changes what the project *can do*: a new tool, page, editor module or command; a change to the engine boundary (a command, a DTO field, an error or issue code); a content-schema change; a rename or removal that breaks a caller; a new ADR that changes how something works |
| **patch** | `0.1.0` → `0.1.1` | makes what already exists work *correctly*: a bug fix in the engine or the UI, a rendering or layout correction, performance work, a refactor, a test, a tightened type |

**Never bump the major.** That is the author's call — before 1.0 a breaking
change is an ordinary minor (`CLAUDE.md`, "Versioning"). If a push feels like it
deserves 1.0, say so and let them decide.

### Do it

The version sits in nine places across seven files, and a `[workspace.package]`
version that disagrees with the `version = "…"` pins on the path dependencies
stops `cargo` resolving the workspace at all. Use the script, never an editor:

```bash
node .claude/skills/commit-and-push/scripts/bump-version.mjs --show      # current
node .claude/skills/commit-and-push/scripts/bump-version.mjs patch       # or: minor
```

It refuses to run when the sites disagree, which means an earlier bump stopped
half way — align them by hand first.

### Then verify again

The version is compiled into the engine: `EngineInfo` reads `CARGO_PKG_VERSION`,
the badge's tooltip shows it, and the smoke transcript pins it. So a bump is not
inert — rebuild and re-run:

```bash
npm run wasm:build
npm run check
node .claude/skills/verify-no-regression/scripts/smoke.mjs
```

The transcript will report exactly one diff, `engine.version: "0.1.0" ->
"0.1.1"`. That one line is the bump and is accepted with `--accept`. **Any other
line is a regression** — the bump did not cause it, so do not accept it away.

The bump is its own commit, last, just before the push:

```bash
git add package.json package-lock.json Cargo.toml Cargo.lock \
        apps/desktop/Cargo.toml apps/desktop/Cargo.lock apps/desktop/tauri.conf.json
git commit -m "$(cat <<'EOF'
bump version to 0.1.1

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

## 5. Stage deliberately

```bash
git add <path> [<path> …]
```

Path by path — never `git add -A`. Then confirm with `git status --short` that
what is staged is exactly what you reviewed.

## 6. Write the message in this repo's style

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

## 7. Push

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

## 8. Report

```
verified   npm run check passed · smoke verdict clean
commit     0e9e783 paint elevation with the raise tool
           a71c204 bump version to 0.1.1
version    0.1.0 → 0.1.1 (patch — a rendering fix, nothing new)
files      3 changed (crates/world/src/definition.rs, apps/web/src/…, docs/…)
pushed     origin/main → git@github.com:lucaspouchot/insulaire.git
left out   apps/web/src/styles.css (unrelated local edit)
```

Confirm afterwards with `git status --short` (clean or only the files you
deliberately left) and `git log --oneline -1`.

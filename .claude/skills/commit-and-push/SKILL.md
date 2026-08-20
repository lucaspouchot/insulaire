---
description: Commit the verified working tree and push it — review the diff, check the docs/ADRs that the change owes, bump the patch or minor version when shipped code changed, write the message in this repo's style, push to origin and report the SHA.
name: commit-and-push
---

# Commit and push

Turns an **already verified** tree into a pushed commit, plus a version bump when
shipped code moved. It does not re-prove the work: verification happened when the
change was made, and the user has reviewed it since.

## 1. Confirm it was verified — do not re-verify

By the time this skill runs, [verify-no-regression](../verify-no-regression/SKILL.md)
has normally already run on this exact tree. **Trust that run.** Re-running the
gates and the smoke harness on an unchanged tree costs minutes and a lot of
context to reprint a verdict that is already known.

Re-run it only when one of these is true:

- it never ran on this change;
- files changed after it ran (you kept editing, or the user did);
- the last verdict was `regression`, or a gate was red.

The objective check, when unsure:

```bash
git status --porcelain -uall            # what is dirty
stat -c '%Y %n' .smoke/current/report.json
```

Report newer than every file you are about to commit → it covers this tree.

If the verdict was `regression` or a gate is red → **stop**, say what is red.
Commit red work only if the user asks, and say so in the message. A
`no-baseline` verdict is acceptable — mention that nothing was compared.

## 2. Review what is about to be committed

```bash
git status --short
git diff
git diff --cached
```

- **Nothing incidental**: `.smoke/`, `deliveries/`, `dist/`, `target/`,
  `public/wasm/`, `public/content/` are gitignored — one showing up means the
  ignore rules are wrong; fix those instead of committing the file.
- **No leftovers**: `console.log`, `dbg!`, `todo!()`, commented-out blocks,
  `it.only` / `#[ignore]`, local paths, a seed or port switched for a one-off.
- **No secrets**, no absolute home paths.
- **Only this change**: leave unrelated dirty files out, and say you left them.

## 3. Pay what the change owes

Per `CLAUDE.md`, write the missing one *before* committing, not after:

- architecture decision changed or added → an ADR in `docs/adr/` (skill:
  `create-adr`), and the ADRs it supersedes updated;
- user-visible behaviour → the specs, per `maintain-project-specs`;
- engine boundary → `docs/wasm-api.md` + `apps/web/src/engine/engine.types.ts`;
- content schema → `docs/content-format.md` + the files under `content/`;
- a feature the smoke run would not notice → a step or page in the scenario.

## 4. Bump the version

**A push that changes shipped code carries a bump.** The unit is the push, not
the commit: one bump covers everything going out.

```bash
git diff --name-only @{u}...HEAD        # everything since the last push
```

Only `docs/**`, `README.md`, `CLAUDE.md`, `LICENSE`, `.claude/**` moved → **no
bump**, say so. Anything else (`crates/**`, `apps/**`, `content/**`,
`scripts/**`, the manifests) is shipped code and gets one.

| Bump | The push… |
|---|---|
| **minor** `0.1.0` → `0.2.0` | changes what the project *can do*: a new tool, page, editor module or command; an engine-boundary change (command, DTO field, error or issue code); a content-schema change; a rename or removal that breaks a caller; a new ADR |
| **patch** `0.1.0` → `0.1.1` | makes what exists work *correctly*: a bug fix, a rendering or layout correction, performance, a refactor, a test, a tightened type |

Read the diff, not the subjects; when both apply the higher wins. **Never bump
the major** — that is the author's call (`CLAUDE.md`, "Versioning").

The version sits in nine places across seven files, and a `[workspace.package]`
version disagreeing with the path-dependency pins stops `cargo` resolving the
workspace. Use the script, never an editor:

```bash
node .claude/skills/commit-and-push/scripts/bump-version.mjs --show   # current
node .claude/skills/commit-and-push/scripts/bump-version.mjs patch    # or: minor
```

It refuses to run when the sites disagree, and re-reads each file after writing
it — that *is* the verification of the bump. **Do not rebuild, re-run the gates
or re-run the smoke harness afterwards**: a version string is not behaviour, and
the harness reports `engine.version` as a note rather than a diff
(`NOT_BEHAVIOUR` in `smoke.mjs`), so there is nothing left to accept.

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

## 5. Stage, then write the message in this repo's style

`git add <path> …` path by path — never `git add -A` — then check
`git status --short` shows exactly what you reviewed.

Subjects here are short, lowercase and imperative (`git log --oneline -10`):
`add isometric view`, `fix raise and down tile`. No `feat:`/`chore:` prefix, no
trailing period, ≤ 60 characters. A body only when the subject cannot carry it:
wrapped at 72 columns, saying **why**, naming the ADR or doc the change follows.
One commit = one coherent change.

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

Trunk-based: `main` is the branch and what `origin` tracks. `git push` as is —
a branch and a PR only when the user asks.

- No upstream → `git push -u origin <branch>`.
- Non-fast-forward → `git pull --rebase`; re-run `verify-no-regression` only if
  the rebase brought in someone else's commits, then push again.
- **Never** force-push `main` or rewrite a pushed commit unless asked.
- Hook or CI rejection → report the reason, do not work around it.

## 7. Report

```
verified   reused the run from this session — check passed · smoke clean
commit     0e9e783 paint elevation with the raise tool
           a71c204 bump version to 0.1.1
version    0.1.0 → 0.1.1 (patch — a rendering fix, nothing new)
pushed     origin/main
left out   apps/web/src/styles.css (unrelated local edit)
```

---
description: Commit the working tree and push it — read the diff and the session, split it into coherent commits, write the messages in this repo's style, bump the version last, push to origin and report the SHAs. Runs no tests, ever.
name: commit-and-push
---

# Commit and push

Four steps, in this order: **read the changes → commit them → bump the version →
push.** Nothing else.

## This skill never runs tests

Do not run `npm run check`, `npm test`, `cargo test`, `cargo clippy`, `cargo
fmt`, `npm run test:web`, `npm run test:scripts`, the smoke harness, a build, or
any other gate. Not to "confirm", not "just the fast one", not because the diff
looks risky, not because the tree has not been verified.

Verifying is [verify-no-regression](../verify-no-regression/SKILL.md)'s job, and
it belongs to the moment the change was made — not to the moment it is
committed. Re-proving a tree here costs minutes and a great deal of context to
reprint a verdict that is either already known or deliberately not wanted.

If you know nothing was verified, commit anyway and **say so in the report**. It
is the user's call, not this skill's.

The only thing worth checking is that git itself is not mid-operation — a rebase
or merge in progress means stop and say so:

```bash
git status --short
```

## 1. Read what changed, and why

```bash
git status --short
git diff
git diff --cached
git log --oneline -10        # the message style you are about to match
```

Two sources tell you what the change *is*:

- **the diff** — what actually moved;
- **the session**, when there is one — what the user asked for, the problem that
  started it, the decision taken along the way. That is where the *why* comes
  from, and a body written from the diff alone can only restate the *what*.

While reading, keep three things out of the commit:

- **incidental files**: `.smoke/`, `deliveries/`, `dist/`, `target/`,
  `public/wasm/`, `public/content/` are gitignored — one appearing means the
  ignore rules are wrong; fix those rather than commit the file;
- **leftovers**: `console.log`, `dbg!`, `todo!()`, `it.only`, `#[ignore]`,
  commented-out blocks, a local path, a seed or port switched for a one-off;
- **secrets** and absolute home paths.

Unrelated dirty files stay out of the commit — leave them, and say so in the
report.

If the change owes a doc under `.claude/rules/specs.md` (a boundary change owes
`docs/wasm-api.md`, a schema change owes `docs/content-format.md`, an
architectural decision owes an ADR), note it in the report. Do not stop, and do
not write it here unless the user asks — this skill commits, it does not author.

## 2. Commit — one commit per coherent change

A tree often holds one change, and then it is one commit. When it holds several
unrelated ones, **split them**: a fix and a refactor that happen to share a
morning are two commits, and a reviewer reading `git log` later should see one
idea per line.

Split by what the change *is*, not by file type or directory. If two paths only
make sense together — a Rust type and the TypeScript mirror that must not drift
— they are one commit. Order them so the tree makes sense at each step.

Stage path by path, **never `git add -A`**, then confirm what is staged is
exactly what you reviewed:

```bash
git add <path> <path> …
git status --short
```

### The message

Subjects here are short, lowercase and imperative — `add isometric view`,
`fix raise and down tile`, `see through relief to reach a hidden hex`. No
`feat:`/`chore:` prefix, no trailing period, 60 characters at most.

Add a body when the subject cannot carry it: wrapped at 72 columns, saying
**why** rather than restating the diff, and naming the ADR or doc the change
follows. Per `CLAUDE.md` ("Versioning"), a breaking change says plainly what
breaks and what is discarded, so it stays legible later.

```bash
git commit -F - <<'EOF'
paint elevation with the raise tool

The tool wrote the terrain index instead of the elevation byte, so a raised
hex rendered flat (docs/adr/ADR-0013-isometric-projection.md).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

Both trailers go on every commit, the session URL when the session has one:

```text
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_<id>
```

## 3. Bump the version — last, just before the push

**A push that changes shipped code carries a bump.** The unit is the push, not
the commit: one bump covers everything going out, so this happens once, after
every other commit is written.

```bash
git diff --name-only @{u}...HEAD        # everything since the last push
```

Only `docs/**`, `README.md`, `CLAUDE.md`, `LICENSE`, `.claude/**` moved → **no
bump**, and say so in the report. Anything else (`crates/**`, `apps/**`,
`content/**`, `scripts/**`, the manifests) is shipped code and gets one.

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
it — that *is* the verification of the bump. Nothing else is needed: a version
string is not behaviour, so **do not rebuild and do not run a gate afterwards**.

The bump is its own commit:

```bash
git add package.json package-lock.json Cargo.toml Cargo.lock \
        apps/desktop/Cargo.toml apps/desktop/Cargo.lock apps/desktop/tauri.conf.json
git commit -F - <<'EOF'
bump version to 0.1.1

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

## 4. Push

Trunk-based: `main` is the branch and what `origin` tracks. `git push` as is — a
branch and a PR only when the user asks.

- No upstream → `git push -u origin <branch>`.
- Non-fast-forward → `git pull --rebase`, then push again. If the rebase brought
  in someone else's commits, say so in the report — whether that needs
  re-verifying is the user's call, and still not this skill's job.
- **Never** force-push `main` or rewrite a pushed commit unless asked.
- Hook or CI rejection → report the reason, do not work around it.

## 5. Report

```text
commit     0e9e783 paint elevation with the raise tool
           a71c204 bump version to 0.1.1
version    0.1.0 → 0.1.1 (patch — a rendering fix, nothing new)
pushed     origin/main
not run    no gate and no smoke run — this skill does not verify
left out   apps/web/src/styles.css (unrelated local edit)
owed       none
```

`not run` is always present: it is what tells the user the tree went out
unproven by this step.

# Windows has no `sh`, which is what `just` reaches for by default, so every
# recipe here would fail before running a single command. The recipes are lists
# of `npm` and `node` calls and nothing else — no pipes, no globbing, no POSIX —
# so PowerShell runs them exactly as a shell does.

set windows-shell := ["powershell.exe", "-NoLogo", "-Command"]

# Start the dev environment. Extra arguments go to `ng serve` untouched, so
# `just run --host 0.0.0.0` exposes the app to the local network and

# `just run --port 4399` moves it off the default port.
run *args:
    npm install
    npm run wasm:build
    npm run dev -- {{ args }}

# Run the desktop shell against the live dev server: the game in its own window,

# reloading like the browser does.
desktop:
    npm install
    npm run wasm:build
    npm run desktop:dev

# Build the client delivery: the game without the editor, as an executable for

# the machine you are on, collected under deliveries/ (ADR-0017).
deliver:
    npm install
    npm run wasm:build
    npm run desktop:build
    node scripts/verify-client-build.mjs
    node scripts/collect-bundles.mjs

# Regenerate the application icons from apps/desktop/icons/icon.svg.
icons:
    npm run desktop:icons

# Everything the CI gate runs: clippy, rustfmt, Rust tests, web tests.
check:
    npm run check

# The desktop shell's own gate. Separate because it needs the GTK and WebKit

# development packages that `check` deliberately does without.
check-desktop:
    npm run check:desktop

# Count lines of code with cloc (https://github.com/AlDanial/cloc). With no
# argument, counts the tracked working tree via `git ls-files`, so
# node_modules, target/, dist/ and every other gitignored path are excluded
# automatically. Pass a commit-ish (`just cloc HEAD~5`) to count the tree at
# that ref instead.
#
# `--exclude-dir=generated,wasm,tests` plus the `--not-match-f` basenames drop
# two kinds of code that inflate a size comparison:
# - generated: `apps/web/src/content/generated/`, `crates/wasm/src/lib.rs`
#   (`scripts/generate-content-types.mjs`) and `crates/engine/src/json.rs`
#   (`scripts/generate-seam.mjs`) all carry an `// @generated` header — see
#   `npm run check:types` / `check:seam`. Add a new generated file's
#   directory or a unique basename here if the seam grows a fifth copy.
# - tests: dedicated test files (`*.spec.ts`, `*.test.mjs`,
#   `crates/engine/src/json/tests.rs`, `crates/engine/tests/`). This does
#   *not* catch a Rust `#[cfg(test)] mod tests { .. }` inlined in an
#   otherwise-production file — cloc counts whole files, not blocks inside
#   them, so those still count as source.
cloc *commit:
    cloc --exclude-dir=generated,wasm,tests --not-match-f='^json\.rs$|^tests\.rs$|\.spec\.ts$|\.test\.mjs$' {{ if commit == "" { "--vcs=git ." } else { commit } }}

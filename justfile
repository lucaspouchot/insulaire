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
    npm run dev -- {{args}}

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

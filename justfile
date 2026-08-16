run:
    npm install
    npm run wasm:build
    npm run dev

# Run the desktop shell against the live dev server: the game in its own window,
# reloading like the browser does.
desktop:
    npm install
    npm run wasm:build
    npm run desktop:dev

# Build the client delivery: the game without the editor, as an executable for
# the machine you are on, collected under deliveries/ (ADR-0020).
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

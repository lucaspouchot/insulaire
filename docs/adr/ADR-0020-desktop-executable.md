# ADR-0020 — Ship the Client as a Desktop Executable (Tauri 2)

## Status
Accepted. Amends ADR-0012 (distribution shape) and withdraws the archive
packaging of ADR-0018, whose editor-free build survives unchanged.

## Context

ADR-0012 chose a static web bundle and wrote down its own risk: *"opening
`index.html` directly through `file://` is subject to browser security
restrictions… this constraint must be tested early."* It was tested, and it
failed exactly as predicted — a client who unzipped the delivery and
double-clicked `index.html` got a black screen, because each `file:` URL is an
opaque origin and the module imports, the WASM glue and the content fetches are
all blocked.

The first answer was a launcher inside the archive: a loopback static server in
PowerShell. It works, and it is still the right answer for a *web* delivery. But
it asks a player to run a script that starts a server, leaves the game without
an icon, a window title or an entry in the applications menu, and offers no path
to a store.

The new requirement is explicit: **an executable** for Windows, macOS, Ubuntu,
Debian and Arch, with room for the Steamworks API later. CLAUDE.md listed
desktop packaging among the initial non-goals — "do not add *without an explicit
requirement*" — and this is that requirement, so the non-goal is lifted rather
than bypassed.

**Electron was rejected**: it would ship a second JavaScript runtime and a whole
Chromium next to a game whose entire simulation is already Rust, turning a
~10 MB delivery into a ~150 MB one, for a webview the operating system already
provides.

**A native rewrite of the client was rejected** outright: it would duplicate the
renderer and the interface, which is exactly the drift ADR-0018 refused for the
editor.

**Keeping the browser delivery alongside** was considered and dropped: two
packaging paths to maintain for one audience. The web build remains what
development and the editor use — it is simply no longer what a player receives.

## Decision

**A Tauri 2 shell in `apps/desktop` hosts the existing web bundle.** The shell
owns the window, the embedded assets and native services. It does not own a
single game rule. `frontendDist` points at the `deliver` build, so what ships is
still the editor-free bundle ADR-0018 defines, produced by the same file
replacement.

**The engine stays WebAssembly inside the webview.** Linking `insulaire-engine`
natively and calling it over Tauri's IPC was rejected for now: the editor's
browser build needs the WASM boundary anyway, so a native path would mean two
boundaries to keep in step, and every tick would pay a serialisation it does not
pay today. The seam that would make the swap possible already exists in
`load-engine-module.ts`, and this ADR does not close it.

**The shell is its own cargo workspace**, depending on nothing in `crates/`. The
engine gate — `just check` — therefore stays headless and needs no GTK or WebKit
development packages; the shell has its own, `just check-desktop`.

**One executable per platform, built where it runs.** Tauri cannot
cross-compile, so `just deliver` builds for the machine it runs on, and
`.github/workflows/release.yml` builds the matrix: `.msi`/`.exe` on Windows,
`.dmg` on macOS for both architectures, `.deb`, `.rpm` and `.AppImage` on
**ubuntu-22.04** — the oldest supported glibc, because a binary linked against a
newer one refuses to start on an older system. Arch is served by the AppImage;
a PKGBUILD can be added later without changing anything here.

**`deliveries/` still holds the thing to send.** `scripts/collect-bundles.mjs`
gathers the installers *and the bare executable*, hashes them and names them.
The bare executable is collected deliberately: the frontend and the engine are
embedded in it, so it is a complete build, and a Steam depot takes a build, not
an installer.

**Steam is a seam, not an integration.** `apps/desktop/src/steam.rs` is a facade
behind the `steam` cargo feature, off by default, because the Steamworks SDK is
not redistributable and must not become a condition for building the game.
Without the feature the facade is inert and says so; with it, it connects to a
running client and unlocks achievements. Nothing in the game may fail because
Steam is absent.

**The webview's Content-Security-Policy is explicit**, in `tauri.conf.json`, and
two of its consequences are load-bearing — both were found by running the window,
not by reading:

- `script-src` must include `'wasm-unsafe-eval'`, or the engine cannot
  instantiate. `style-src` must allow inline styles, because Angular injects
  component styles at runtime — and `dangerousDisableAssetCspModification`
  names `style-src` for a reason: Tauri otherwise adds a nonce to that
  directive, and a CSP that carries a nonce makes browsers *ignore*
  `'unsafe-inline'`, which blanks the interface.
- the `deliver` configuration turns **`inlineCritical` off**. Angular's critical
  CSS optimisation loads the real stylesheet with
  `media="print" onload="this.media='all'"`, and that inline handler is exactly
  what `script-src-attr` refuses: the stylesheet stays print-only and the game
  renders unstyled. Disabling the optimisation removes the inline handler
  instead of widening the policy for it.

## Consequences

Positive:
- a player double-clicks one file, which is what was asked, and gets a window
  with a name and an icon instead of a browser tab;
- the delivery no longer depends on the player's browser, on a script that opens
  a port, or on anything installed on their machine beyond the system webview;
- the shell is a few hundred lines: the game, the renderer and the engine are
  untouched by this decision, and the browser build still runs the same code;
- the Steam requirement has a place to land that does not hold the repository
  hostage to a licence-restricted SDK.

Negative:
- **no machine can build the delivery on its own.** Windows, macOS and Linux
  artefacts each need their own runner, so releasing is a CI operation now;
- the webview is the platform's, not ours: WebKitGTK on Linux, WKWebView on
  macOS, WebView2 on Windows. Rendering and performance must be checked on each,
  and a very old system webview is a support case a browser build did not have;
- Windows requires the WebView2 runtime; the installer embeds the bootstrapper,
  which needs network access at install time on a machine that lacks it;
- macOS builds are unsigned: Gatekeeper will warn until an Apple Developer ID
  and notarisation are configured — and Steam will require the same;
- two cargo workspaces mean two lock files and two caches, and `just check` no
  longer covers the shell — a divergence only `just check-desktop` catches;
- the Steamworks half of `steam.rs` cannot be compiled in this repository as it
  stands: it is written against the documented API and stays unverified until
  someone builds it with the SDK and an AppID;
- automatic updates are not configured. Tauri's updater would need signing keys
  and somewhere to host a manifest; a store handles it instead, so this is
  deliberately deferred.

## Rule

The desktop shell may contain the window, the embedded assets and native
services only. Game rules, content and state stay in the engine and in the web
bundle the shell hosts — anything a player receives is built from the `deliver`
configuration, never from a source the browser build does not also use.

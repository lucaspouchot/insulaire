# ADR-0015 — Ship the Client as an Editor-Free Build of the Same Source Tree

## Status
Accepted

## Context

The application serves two audiences from one code base: the team authoring
content, and the client who receives a game. The client's build must not contain
the editor — not for secrecy alone, but because an "Editor" tab in a delivered
game is a defect, and because the editor's code, its `localStorage` document
restore and its export dialogs have no business running on a player's machine.

ADR-0009 already fixes the delivery *shape*: a static bundle, no backend. What
was missing was how one source tree produces two bundles, and how the game finds
its content without the editor's state.

**A runtime flag** (`if (!production) show the editor`) was rejected: the editor
still ships, the bundle still pays for it, and a URL is all that separates a
client from it.

**A second Angular application** in `apps/` was rejected as duplication of the
shell, the renderer, the services and the engine bindings — two apps that must
not drift, to remove one tab.

**A dynamic import behind a flag** was rejected on evidence: a bundler emits the
chunk for an `import()` it can see, even in a branch that is statically false.
Absence has to be structural.

## Decision

**Two build configurations, one source tree, separated by file replacement.**
The `deliver` configuration swaps exactly two files:

| dev | client |
|---|---|
| `app.routes.ts` (game + editor) | `app.routes.deliver.ts` (game only) |
| `build-features.ts` (`editor: true`) | `build-features.deliver.ts` (`editor: false`) |

The routes file is the *only* place the editor is imported, so the client build
emits no editor chunk at all. `BUILD_FEATURES` then governs the shell: no
Editor link, and no restoring edited documents from `localStorage`.

**The client boots from the project manifest.** `content/project.json`
(`ProjectDefinition`) lists the tile sets and worlds a game is made of and names
its `startWorld`. The client loads exactly what it lists, registers it with the
engine, calls `loadProject` — which validates the manifest against what is
actually loaded — and starts on the start world. No editor state is involved, so
both builds play identical content by construction.

**Assets resolve against `document.baseURI`.** The `deliver` configuration sets
`baseHref: "./"`, and `assetUrl()` resolves content and WASM paths against the
base rather than the site root, so an unzipped bundle works from any
subdirectory.

**The bundle is not opened directly.** A bundle opened as a `file:` URL is a
black screen: each such URL is an opaque origin, and the module imports, the WASM
glue and the `content/*.json` fetches are all blocked (ADR-0009). What a player
receives is a desktop executable that hosts this bundle (ADR-0017); what remains
of the earlier archive-and-launcher answer is the inline notice in `index.html`,
which now catches a developer opening a `dist/` build by hand.

**`just deliver` builds the executable** (ADR-0017): the WASM engine, then
`content/` mirrored, then this configuration's bundle, then the Tauri shell
around it, then `scripts/verify-client-build.mjs`, then `deliveries/`. That
verification is what survived the packaging script: the executable embeds this
bundle verbatim, so it fails if `index.html`, the `.wasm` or
`content/project.json` is missing, or if any emitted chunk still contains an
editor component — the last gate before a client sees anything.

## Consequences

Positive:
- the delivered bundle cannot contain the editor by accident: the check runs
  every time, and the routes file makes it true by construction;
- one shell, one renderer, one engine boundary — no second app to keep in step;
- the client build is a plain folder of static files that works from any path,
  including a subdirectory of an existing site;
- the same bundle serves the browser during development and the executable a
  client installs, so a bug can never be "only in the delivery";
- deliveries are hashed and git-ignored, so what was sent can be identified
  after the fact.

Negative:
- `fileReplacements` is invisible from the source: reading `app.routes.ts` does
  not tell you a second variant exists. The two files must be kept in step by
  hand, and only the packaging check would catch a divergence;
- every editor-only feature must live behind the routes file or `BUILD_FEATURES`,
  or it will leak into the client bundle;
- the editor check is a string search over emitted chunks: it proves the two
  known editor components are absent, not that nothing editor-shaped ever leaks;
- `deliveries/` accumulates builds until someone deletes them.

## Rule

The editor may only be reached through `app.routes.ts`; anything a client build
must not contain has to be absent from `app.routes.deliver.ts`'s import graph,
not merely hidden behind `BUILD_FEATURES`.

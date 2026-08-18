# ADR-0022 — Author Content in a Directory Named by `.env`, Served by a Dev-Only Content Server

## Status
Accepted

## Context

`content/` at the repository root is two things at once, and they have started
to pull apart.

It is the **fixture**: `crates/engine/tests/shipped_content.rs`,
`world-serializer.spec.ts`, `engine-integration.spec.ts` and the smoke harness
all read those exact files, and a byte-for-byte transcript comparison depends on
them not moving. It is also, today, the only place a **game** can be written —
so authoring a real game means editing the engine's test data, and a designer's
map is a test failure waiting to happen.

The game being built lives outside this repository, as it should: it is content,
with its own history and its own release rhythm. Authoring it needs three things
this repository could not do:

1. **Point the application at another directory.** The path is per machine and
   per game — it belongs in local configuration, not in a committed file.
2. **Serve that directory.** `scripts/sync-content.mjs` copied `content/` into
   `apps/web/public/content/` because the Angular builder only accepts assets
   inside its own workspace. A copy is fine for a build and wrong for
   authoring: the file on disk and the file in the browser drift apart, and the
   drift is silent.
3. **Write into it.** Importing an image, a music track or a tile set means
   putting a file on disk. A browser cannot, and the editor's answer so far —
   `localStorage` plus a download — does not produce a project anyone can commit.

**A backend for the game** was never on the table: ADR-0012's "no application
server" is what makes the delivery a folder of static files, and ADR-0020 what
makes it an executable. Neither may acquire a runtime dependency on a server.

**Angular dev-server middleware** was the obvious place to put the upload
endpoint, and `@angular/build:dev-server` has no hook for it: the builder owns
the Vite server and exposes only `proxyConfig`.

**Writing through the Tauri shell** would work for the desktop build and not in
a browser, which is where the editor actually runs.

## Decision

**One variable names the directory.** `INSULAIRE_CONTENT_DIR`, read from `.env`
at the repository root by `scripts/content-dir.mjs` (via Node's own
`process.loadEnvFile`, so no dependency). Absent, it is `content/` — the
fixture — which is what a fresh checkout wants. The environment beats `.env`,
which is how the smoke harness pins the fixture regardless of what a developer
is authoring.

**A separate process serves that directory, and only in development.**
`scripts/content-server.mjs` binds to `127.0.0.1`, on a port the operating
system picks, and answers five routes:

```text
  GET    /api/content/health      which directory is being served
  GET    /api/content/tree        every content file, with size and mtime
  GET    /content/<path>          read a file
  PUT    /api/content/<path>      write a file, creating directories
  DELETE /api/content/<path>      remove a file
```

`scripts/dev.mjs` starts it, writes a proxy configuration carrying the chosen
port, and runs `ng serve --proxy-config` in front of it. So `/content/...`
resolves to the real directory during development, and to files next to
`index.html` in a build — `assetUrl()` is unchanged, and no application code
knows which of the two it is talking to.

**An ephemeral port, not a fixed one.** Two dev servers must be able to run at
once — a developer's, and the smoke harness's on its own port — and a fixed
content port would have one of them silently serving the other's game.

**The path rules are the security boundary, and they are tested.**
`scripts/content-paths.mjs` resolves a request path inside the root or refuses
it: no `..`, no absolute path, no drive letter, no null byte, and an extension
from a fixed list of content types (`.json .md .png .jpg .webp .svg .ogg .mp3`
…). `scripts/content-paths.test.mjs` runs under `node --test` in `npm test`.

**Mirroring is now a build step only.** `scripts/sync-content.mjs` runs from
`prebuild` and `prebuild:deliver`, copying whichever directory is configured
into the bundle, and `scripts/dev.mjs` deletes a stale mirror at startup so it
can never shadow the proxy.

**The editor is the only caller.** `ContentWorkspaceService` is guarded by
`BUILD_FEATURES.editor` and reachable only from editor components, so it stays
out of the client bundle by the same construction as the editor itself
(ADR-0018). The game reads content as static files, exactly as the delivered
executable does.

## Consequences

Positive:
- a game is authored in its own repository, and this one keeps a fixture small
  enough to reason about — the two stop being the same files;
- an uploaded asset is on screen immediately: there is no copy to go stale, and
  no build to wait for;
- the editor can produce a project someone commits, rather than a download;
- the runtime is untouched: no build of the game talks to this server, and
  ADR-0012's invariant holds as written;
- which directory is in use is printed at startup and shown in the editor's tab
  bar, so "I was editing the wrong game" is visible rather than discovered.

Negative:
- `npm start` now starts two processes, and a crash in the content server is a
  404 on content rather than a loud failure;
- an authoring server that writes files exists on the developer's machine. It is
  bound to loopback and restricted by extension and path, but it is a real
  attack surface if a machine runs untrusted pages;
- `.env` is invisible from the source tree: two developers can be running the
  same commit against different content, and only the startup banner says so;
- the fixture and the authored game can drift apart — the fixture proves the
  engine, not the game, and only the smoke harness keeps it honest;
- a delivered bundle is built from whatever `INSULAIRE_CONTENT_DIR` said at
  build time, so `just deliver` on a misconfigured machine ships the fixture.
  `scripts/verify-client-build.mjs` checks that content is present, not that it
  is the right game.

## Rule

Application code reads content through `assetUrl('content/…')` and nothing else.
Writing content is an editor-only capability, goes through
`ContentWorkspaceService`, and may never be reachable from
`app.routes.deliver.ts`'s import graph.

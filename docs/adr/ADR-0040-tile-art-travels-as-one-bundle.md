# ADR-0040 — Tile Art Travels as One Bundle

## Status
Accepted. Extends `docs/adr/ADR-0038-a-map-is-drawn-from-shared-pictures.md`,
which held a map back until its pictures were in hand and left "pack the tile
set into an atlas" explicitly open. This closes that opening — with a bundle
rather than an atlas. Nothing about *what* a cell looks like changes, only how
many requests it takes to get the pixels.

## Context

A map took about **six seconds to appear** on the dev server, and the report
that opened this was "there are only seven kinds of tile".

Seven kinds of tile is right. It is also a hundred and eighty-four files: eight
variants per terrain, in flat, surface and three elevation levels, at 64x74,
64x40 and 64x26. **248 kB in total, about 1.4 kB each.** Opening `/editor/map`
fetches 128 of them; `/play` fetches 96.

The numbers say where the six seconds went. Measured in the browser, on the dev
server, over HTTP/1.1:

| | requests | transferred | median service | median queued | span |
|---|---|---|---|---|---|
| tile art | 128 | 201 kB | **4 ms** | **3417 ms** | 6864 ms |

The server answers each image in four milliseconds and the browser spends three
and a half seconds with the request queued behind the six connections a origin
is allowed. On the machine this was developed on the same page queues for 64 ms
rather than 3417 — the cost is environmental, and 84 of those 128 requests
opened a fresh connection, so whatever a connection costs is paid dozens of
times. **The cost is the number of requests. It is not the bytes, and it is not
the server.**

That also explains the observation that started the investigation: the delivered
executable loads the same 128 files without trouble. It does not serve them over
HTTP at all — Tauri hands them to the webview over `tauri://localhost` from
`frontendDist`, with no connection to open and no queue to wait in
(`docs/adr/ADR-0020-desktop-executable.md`).

Three answers were rejected.

**Do nothing, because HTTP/2 fixes it.** It does, and it is one flag: Vite
serves HTTP/2 when given TLS, Angular generates the certificate, and the
`/content` proxy carries it — `just run --ssl` takes the same page from 64 ms of
queueing to 18 ms, with every request negotiating `h2`. It is worth using and it
is now the recommended way to run the dev server. It is **not** an answer:
`just desktop` points a WebKit webview at `http://localhost:4200` and will not
accept a self-signed certificate, a browser build served from an ordinary static
host is back on HTTP/1.1, and none of it makes a hundred and eighty-four
requests a reasonable way to fetch 248 kB.

**A texture atlas.** One image on a grid, drawn with a source rectangle per
sprite. It is the usual engine answer and it would have touched
`TileAppearanceCache`, `drawPaintedCell`, the composition, `SpriteSource`, the
tile preview and the editor's two sprite sources — every one of them to solve a
transport problem. It also buys nothing at draw time that ADR-0038 has not
already bought: looks are composed once and shared, so the blits are already
bounded by the palette rather than by the map.

**A WebSocket, or any other custom transport.** It multiplexes, which is the
right instinct, but it is a protocol to write, to test and to run — and a
delivered build has no server to run it against (`ADR-0012`). One file over
plain HTTP multiplexes just as well and needs none of it.

## Decision

**A directory of sprites travels as one file.** `scripts/sprite-bundle.mjs`
packs every allowed file under `assets/tiles` into a bundle: a four-byte magic,
a version, a JSON header of `{ path, type, offset, length }`, then the files
concatenated. `apps/web/src/content/sprite-bundle.ts` reads it back. 184 files,
one request, 266 kB — 18 kB more than the sum of the parts, and 183 round trips
fewer.

**It is a transport format, not an atlas.** No grid, no source rectangles, no
composition. The browser slices the bundle into one `ImageBitmap` per asset at
load, and because an `ImageBitmap` is a `CanvasImageSource`, `SpriteCache.image`
returns what it always returned. **Nothing downstream of the cache changes** —
the renderer, the appearance cache, the composition and the previews are
untouched, and the canvas is byte-identical.

**The same URL is answered by two different things.** In development the
content server generates it in memory at `/content/tile-art.bundle`; in a build
`scripts/sync-content.mjs` writes that file into `public/content/`. The runtime
asks for one path and never learns which answered.

**A cached bundle is only as valid as the directory's signature** — every path,
size and mtime under `assets/tiles`. The content directory is authored while the
server runs: the asset editor writes through it (`ADR-0030`), and the seeder or
a `git checkout` can change it behind the server's back (`ADR-0022`). A couple
of hundred `stat` calls, once per page load rather than once per image, is what
makes it safe to hold one in memory.

**It is an optimisation and never a rule.** `loadBundle` rejects when there is
no bundle to be had — an unknown URL, a corrupt file, a browser without
`createImageBitmap` — and every caller catches into the per-file path that
existed before. This is the same bargain ADR-0038 strikes for composition:
faster when it works, identical when it does not.

**It covers tile art and nothing else.** Character sprites are twenty files, and
the title image is 2.4 MB that only the title screen ever wants; pulling either
into the wait a map already has would make the map slower to serve a screen that
is not being shown.

**A client build without one does not ship.** `scripts/verify-client-build.mjs`
requires `content/tile-art.bundle` next to the engine and the project. A missing
bundle is survivable at run time and is not survivable as a release: it means
`sync-content` did not run, and the client would quietly pay the hundred and
eighty-four requests this decision exists to remove.

**The bundle is generated output, never content.** `.bundle` is not an allowed
content extension, so nothing can upload one and have the server serve it back,
and it is absent from `/api/content/tree`: what an author edits is the hundred
and eighty-four PNGs, which is what the asset editor opens.

## Consequences

Positive:

- **a map costs one request instead of 128.** Measured on `/editor/map`, the
  same dev server, with latency injected per request to stand in for a slower
  path between browser and server:

  | added latency | before | after |
  |---|---|---|
  | 0 ms | 419 ms · 174 requests · 128 images · 58 ms queued | **331 ms** · 47 requests · **0 images** |
  | 25 ms | 894 ms · 154 ms queued | **509 ms** |
  | 50 ms | 1556 ms · 284 ms queued | **777 ms** |

  The bundle itself is 266 kB and arrives in 14 ms, 28 ms and 54 ms — one round
  trip, paid once. The queueing term, which is the whole of the six seconds
  reported, is gone; what remains grows with latency once instead of sixteen
  times. The delivered build goes the same way: 125 requests to 23, and 1485 ms
  to 691 ms at 50 ms of latency;
- it holds as the project grows. Decoration will multiply the file count, and
  the file count is no longer what a map waits on;
- **the change stops at `SpriteCache`.** One class gained a method, two pages
  call it, and no renderer, resolver or editor knows the bundle exists;
- the format is written once and read once, and the web spec drives the real
  Node writer, so the two halves cannot drift apart without a test failing.

Negative:

- **18 kB more on the wire**, and every byte of it arrives whether the map uses
  the sprite or not — `/play` needed 96 of the 184. That is the trade: bytes are
  not what a map waits on;
- **a bundle is all-or-nothing.** A single corrupt byte in the header sends the
  whole map back to fetching 184 files, where before one bad file cost one tile
  its picture;
- **the dev server does work per request**: a signature over a couple of hundred
  files, and a rebuild whenever one of them moves. It is milliseconds, once per
  page load, and it is the price of never showing an author the file they have
  just replaced;
- **two ways to answer one URL** — generated in dev, written at build — so a
  change to the format has to move both, and `npm run build` has to have run for
  a build to have a bundle at all;
- **the editor's own sprite sources do not use it.** `SpriteSource` was
  deliberately left alone, so the tile and character workspaces still fetch file
  by file. They open one asset at a time, which is the case the bundle does not
  help.

## Rule

Art that a map cannot draw without travels as one file. Individual sprites
remain what is authored, edited and versioned; the bundle is generated, is
answered at the same URL in development and in a build, and is never what a
correct render depends on.

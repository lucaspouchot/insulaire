# ADR-0027 — A Map Is Drawn from Shared Pictures, Delivered as One Bundle

## Status
Accepted

## Context

Three things were visible on a **20x20** map, and each gets worse with every tile
a project adds.

**The map was watched as it loaded.** Tile images were fetched the first time a
cell asked for one, so the first frame was flat colour and the terrains arrived
one at a time over the following second. Every arrival called back into the page,
which rebuilt the whole render model — seventy-five rebuilds for the demo world,
in a burst.

**Every cell paid full price on every frame.** Per visible cell, per frame: a
hash of the tile id including a fresh byte array for its UTF-8, a fresh
`ResolvedTileRender`, one object per stacked layer, and one `drawImage` per
layer. Four hundred cells is thousands of short-lived objects sixty times a
second — the "one JS object per simulated entity" `CLAUDE.md` forbids. Measured
on `/play`, hovering across four hundred cells, three runs: **median 1.1–1.6 ms a
frame, p90 2.9–3.4 ms** — and what matters is not the median but that both grow
with the number of cells on screen. What the map is *made of* is far smaller than
the map: **forty-eight distinct looks** covered all four hundred cells.

**A map took about six seconds to appear** on the dev server, and the report that
opened it was "there are only seven kinds of tile". Seven kinds is right. It is
also 184 files — 248 kB, about 1.4 kB each. Measured over HTTP/1.1: 128 requests,
**median service 4 ms, median queued 3417 ms**, span 6864 ms, with 84 of the 128
opening a fresh connection. The cost is the number of requests. It is not the
bytes, and it is not the server — which is why the delivered executable, handing
the same files to the webview over `tauri://localhost`, never showed it.

Several answers were rejected. **Keeping lazy loading** is what the report was
about, and it scales the wrong way. **Composing per cell without sharing** would
rebuild four hundred canvases a frame to save a few hundred blits — the saving is
in the sharing, not the composition. **A texture atlas** would touch the
appearance cache, the composition, `SpriteSource`, the tile preview and the
editor's two sprite sources, all to solve a *transport* problem, and buys nothing
at draw time that sharing has not already bought. **A WebSocket or other custom
transport** multiplexes, and is a protocol to write, test and run against a
delivered build that has no server. **HTTP/2** genuinely fixes the queueing — one
flag, and `just run --ssl` takes the page from 64 ms of queueing to 18 — but a
WebKit webview will not accept a self-signed certificate, an ordinary static host
is back on HTTP/1.1, and none of it makes 184 requests a reasonable way to fetch
248 kB.

## Decision

**A cell's picture is a flyweight, keyed by its look.** `TileAppearanceCache`
hands out one shared, immutable `TileAppearance` per distinct look. The key is
packed into a single number — palette entry, elevation, steps of exposed face,
surface variant, ladder variant, borrowed ladder — because a template string
would put one string per cell per frame on the heap, which is the cost being
removed.

| Intrinsic — shared | Extrinsic — the cell's own |
|---|---|
| which images draw it, and how they stack | where it is drawn |
| the composed picture | the camera and the zoom |

The cell's coordinates still choose its variant: they pick the look, then stop
mattering.

**A look is composed once**, at the tile set's authored resolution, into one
`OffscreenCanvas`, and every cell wearing that look blits the result — one
`drawImage` however deep the drop. Composition is an optimisation and never a
rule: without `OffscreenCanvas`, past a pixel budget, or before every image has
arrived, the renderer blits layer by layer and draws the same picture.

**A map is not drawn until the pictures it is made of are in hand.**
`warmTileArt()` loads every image the map's own cells can ask for and, until it
settles, `draw` paints the background and nothing else — with the host saying so
on screen, because an empty canvas reads as a broken tool. What is waited on is
the **map**, not the library: the rest of the palette is fetched afterwards,
unwaited, and only by the editor. Only the *first* load is held for, so an edit
that introduces a new picture draws `fallbackColor` until the file arrives — a
map must never blank out under the author's cursor.

**A directory of sprites travels as one file.** `scripts/sprite-bundle.mjs` packs
every allowed file under `assets/tiles` into a bundle: a four-byte magic, a
version, a JSON header of `{ path, type, offset, length }`, then the files
concatenated. 184 files, one request, 266 kB — 18 kB more than the sum of the
parts and 183 round trips fewer.

**It is a transport format, not an atlas.** No grid, no source rectangles, no
composition. The browser slices it into one `ImageBitmap` per asset at load, and
because an `ImageBitmap` is a `CanvasImageSource`, `SpriteCache.image` returns
what it always returned. Nothing downstream of the cache changes.

**The same URL is answered by two different things**: generated in memory by the
content server in development, written into `public/content/` at build time. The
runtime asks for one path and never learns which answered. A cached bundle is
only as valid as the directory's signature — every path, size and mtime under
`assets/tiles` — because the content directory is authored while the server runs.

**Both are optimisations and never rules.** `loadBundle` rejects on an unknown
URL, a corrupt file or a browser without `createImageBitmap`, and every caller
catches into the per-file path. Faster when it works, identical when it does not.

**It covers tile art and nothing else.** Character sprites are twenty files and
the title image is 2.4 MB that only the title screen wants; pulling either into
the wait a map already has would make the map slower for a screen not being
shown.

**A client build without a bundle does not ship.** `verify-client-build.mjs`
requires `content/tile-art.bundle`: a missing one is survivable at run time and
not as a release, because it means `sync-content` did not run. The bundle is
generated output, never content — `.bundle` is not an allowed content extension
and it is absent from the content tree.

**The cache is emptied when what a look *is* changes** — the palette, the pixel
grid, or the projection — and never for terrain, elevation, hover or selection,
which change constantly and change no look.

## Consequences

Positive:
- the map appears whole, in one frame, instead of painting itself over a second;
- **median 1.1–1.3 ms a frame, p90 1.3–2.7 ms** over the same three runs, and 458
  terrain draw calls became 400 for the same picture. A nearly flat four-hundred
  cell map is the *weakest* case: what the measurement shows is that nothing got
  slower;
- the shape of the cost changed. It follows the number of *looks* on screen,
  which the palette bounds, rather than the number of cells, which nothing
  bounds;
- **a map costs one request instead of 128**, and the queueing term — the whole
  of the six seconds — is gone. At 50 ms of injected latency, 1556 ms became 777;
  the delivered build went from 125 requests to 23;
- it holds as the project grows: decoration multiplies the file count, and the
  file count is no longer what a map waits on;
- the change stops at `SpriteCache`: no renderer, resolver or editor knows the
  bundle exists;
- the canvas is byte-identical — the smoke run reports `canvas Δ 0` on every
  screen, composed and uncomposed alike.

Negative:
- **the stage is empty while a map loads.** A deliberate trade — one honest wait
  instead of a picture assembling itself — with no timeout: a map that never
  loads its art shows a loading note forever;
- **18 kB more on the wire**, arriving whether the map uses the sprite or not;
- **a bundle is all-or-nothing**: one corrupt byte in the header sends the whole
  map back to 184 files, where before one bad file cost one tile its picture;
- **two ways to answer one URL**, so a format change has to move both, and
  `npm run build` has to have run for a build to have a bundle;
- **the dev server does work per request** — a signature over a couple of hundred
  files — which is the price of never showing an author a stale file;
- **composed pictures hold memory**, bounded by `MAX_COMPOSED_PIXELS` and
  `MAX_APPEARANCES`; both are bounds, not working sets;
- **a cell whose ladder variant comes from a raw hash cannot be shared**, so
  those cells resolve per frame as they always did;
- the editor fetches the whole palette, and its own sprite sources still fetch
  file by file — they open one asset at a time, which is the case the bundle does
  not help.

## Rule

A map is drawn from pictures it already holds: nothing is resolved per cell per
frame that two cells could share, and nothing is drawn from art that has not
finished loading — the tile's colour is, until it has. Art a map cannot draw
without travels as one file; individual sprites remain what is authored, edited
and versioned, and the bundle is never what a correct render depends on.

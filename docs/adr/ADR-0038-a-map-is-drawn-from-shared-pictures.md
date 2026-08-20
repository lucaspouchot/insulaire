# ADR-0038 — A Map Is Drawn from Shared Pictures, and Only Once It Has Them

## Status
Accepted. Extends `docs/adr/ADR-0035-tile-art-is-authored-and-resolved-by-level.md`
and `docs/adr/ADR-0009-assets-tilesets.md`; nothing about *what* a cell looks
like changes, only how many times that is worked out and when it is shown.

## Context

Two things were visible on a **20x20** map, and both get worse with every tile a
project adds.

**The map was watched as it loaded.** Tile images were fetched the first time a
cell asked for one, which is the first frame it was drawn on. So the first frame
was flat colour, and over the following second the terrains arrived one at a
time: grass, then rock, then water. Worse, every arrival called back into the
page, which rebuilt the whole render model and redrew — seventy-five rebuilds
for the shipped demo world, in a burst.

**Every cell paid full price on every frame.** For each visible cell, each
frame: a hash of the tile id including a fresh byte array for its UTF-8, a fresh
`ResolvedTileRender`, one object per stacked layer, a `CellArt` when the cell had
an authored choice, and one `drawImage` per layer. Four hundred cells is
thousands of short-lived objects sixty times a second — precisely the "one JS
object per simulated entity" `CLAUDE.md` forbids. Measured on `/play`, hovering
across the four hundred cells of the demo map, three runs: **median 1.1–1.6 ms
a frame, p90 2.9–3.4 ms** — and the number that matters is not the median but
that both grow with the number of cells on screen.

What the map is actually made of is far smaller than the map: a palette of seven
tiles, eight variants each, a handful of heights. **Forty-eight distinct looks**
covered all four hundred cells of the demo world.

Three answers were rejected.

**Keep loading lazily and accept the fill-in.** It is what a browser does by
default, and it is what the report was about. It also scales the wrong way: the
window during which a map is half-drawn grows with the number of tiles, and
decoration will multiply them.

**Pack the tile set into an atlas.** One request instead of a hundred is the
real fix for *request count*, and it is a content-pipeline change — the
generator, the schema, the asset editor and every authored variant id. It
remains open, and it is orthogonal to everything below: an atlas would make the
warm-up faster, not unnecessary.

**Compose per cell without sharing.** Stacking a cell's layers into one image
removes the per-layer blits, and doing it per cell would rebuild four hundred
canvases a frame to save a few hundred blits. The saving is in the *sharing*,
not in the composition.

## Decision

**A cell's picture is a flyweight, keyed by its look.** `TileAppearanceCache`
(`apps/web/src/renderer/tile-appearance.ts`) hands out one shared, immutable
`TileAppearance` per distinct look. The key is packed into a single number —
palette entry, elevation, steps of exposed face, surface variant, ladder variant,
borrowed ladder — because a template string would put one string per cell per
frame on the heap, which is the cost being removed.

| Intrinsic — shared | Extrinsic — the cell's own |
|---|---|
| which images draw it, and how they stack | where it is drawn |
| the composed picture | the camera and the zoom |

The cell's coordinates still choose its variant, exactly as before
(`variant_roll`, ADR-0035): they pick the look, then stop mattering.

**A look is composed once, at the tile set's authored resolution.** Its faces
and its top face are stacked into one `OffscreenCanvas` at the offsets
`drawPaintedCell` used to apply blit by blit, and every cell wearing that look
blits the result — one `drawImage` however deep the drop. Composition is an
optimisation and never a rule: with no `OffscreenCanvas`, past a pixel budget,
or before every image has arrived, the renderer blits the layers one at a time
and draws the same picture.

**A map is not drawn until the pictures it is made of are in hand.**
`HexMapRenderer.warmTileArt()` loads every image the map's own cells can ask for
and, until it settles, `draw` paints the background and nothing else. The host
says so on screen — "loading the map…" over the stage — because an empty canvas
with no explanation reads as a broken tool.

**What is waited on is the map, not the library.** The terrain is scanned once
per loaded world for the palette entries actually painted; the rest of the
palette is fetched afterwards, unwaited, and only by the editor, where an unused
tile is a brush someone is about to pick. Play never fetches art its map cannot
show.

**Only the first load is held for.** An edit that introduces a new picture draws
its tile's `fallbackColor` until the file arrives, exactly as before: a map must
never blank out under the author's cursor. `fallbackColor` keeps its job
(ADR-0009) — it is simply no longer what a whole map looks like for a second.

**Arrivals are announced once per frame.** `SpriteCache` coalesces its `onLoad`
into at most one call per animation frame, so a hundred images landing together
cost one model rebuild rather than a hundred.

**The cache is emptied when what a look *is* changes** — the palette, the
authored pixel grid, or the projection — and never for terrain, elevation,
hover or selection, which change constantly and change no look.

## Consequences

Positive:

- the map appears whole. On the shipped demo world its images land within about
  150 ms of one another and are shown in one frame, instead of painting
  themselves over that window;
- **median 1.1–1.3 ms a frame, p90 1.3–2.7 ms** over the same three runs, and
  458 terrain draw calls became 400 for the same picture. A demo map four
  hundred cells wide and nearly flat is the *weakest* case for this: what the
  measurement really shows is that nothing got slower;
- what did change is the shape of the cost. It now follows the number of
  *looks* on screen, which the palette bounds, rather than the number of cells,
  which nothing bounds — a cliff-heavy map of ten thousand cells resolves the
  same forty-eight looks and blits one image per cell instead of one per step
  of relief;
- the canvas is byte-identical to what it was: the smoke run reports `canvas Δ 0`
  on every screen, composed and uncomposed alike;
- the readout says how many pictures the cells shared, so the sharing is visible
  rather than asserted.

Negative:

- **the stage is empty while a map loads.** That is a deliberate trade — one
  honest wait instead of a picture assembling itself — but it is a wait, and on
  a slow enough source it is a long one. There is no timeout: a map that never
  loads its art shows a loading note forever rather than a half-drawn world;
- **the editor fetches the whole palette**, including tiles no cell uses. It is
  bounded by the tile set and it happens after the map is drawn, but it is
  bandwidth a runtime would not have spent;
- **composed pictures hold memory** — up to `MAX_COMPOSED_PIXELS` (four million
  authored pixels, ~16 MB) — and a map with a hundred authored heights refills
  the cache when it passes `MAX_APPEARANCES`. Both are bounds, not working sets;
- **a cell whose ladder variant comes from a raw hash cannot be shared.** A tile
  that authors faces and no top face rolls its cut per cell, so there is nothing
  to share; those cells resolve per frame as they always did, and are not
  composed;
- **`OffscreenCanvas` is required for composition.** Every browser this ships to
  has it; an old WebKit falls back to the layer-by-layer path, which is correct
  and slower;
- **`SpriteSource` grew a `preload`.** Every implementation — including the two
  the editor builds over open sprite buffers — has to answer it.

## Rule

A map is drawn from pictures it already holds: nothing is resolved per cell per
frame that two cells could share, and nothing is drawn from art that has not
finished loading — the tile's colour is, until it has.

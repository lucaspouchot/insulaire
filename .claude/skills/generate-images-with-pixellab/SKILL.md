---
description: Draw any image this project needs with the PixelLab MCP server — tile, character layer, portrait, prop, title art, icon, banner, texture, mockup. Use it for every request to generate, draw, illustrate or edit an image, whatever the destination: which tool draws what here, the prompt contract that keeps the set coherent, the conform step that puts an image on this project's geometry, and how the result is checked before it is committed.
name: generate-images-with-pixellab
---

# Generate images with PixelLab

The `pixellab` MCP server draws pixel art on demand: tiles, characters,
animations, objects, UI panels, fonts. This file says which of its tools draws
what **in this project**, how a prompt has to be written to match the art
already shipped, and what an image goes through before it lands wherever it
belongs — `content/assets/` for game content, anywhere else for the rest.

The complete tool reference — every parameter of every tool — is
**https://api.pixellab.ai/mcp/docs**. Fetch it when a parameter is in doubt
instead of guessing at one, and ask `agent_help` about billing or a tool's
behaviour. What follows is only the part that is specific to Insulaire.

## Every image comes from here

**Any request to make an image is a PixelLab call**, as long as the balance
allows one: a tile, a character layer, a portrait, a prop, title art, an icon, a
banner for the README, a texture, a rough for a screen that does not exist yet.
Not only what lands in `content/assets/`, and not only pixel art meant to ship —
a throwaway rough is a `create_image_pixflux` call, which costs one generation.

What is **not** a PixelLab job:

- a **diagram, chart or schema** — those are drawn as SVG or mermaid, not
  generated;
- a **screen mockup made of real UI** — that is markup, and the `design` or
  `artifact-design` skills own it. PixelLab draws the art *inside* it;
- an image that already exists and only has to be cropped, resized or
  re-encoded — `conform.mjs` does that on its own, without a call;
- anything the user supplied. Their image is the source, not a prompt.

**When the balance does not allow it**, say so with the number, name the
cheapest call that would do (`create_image_pixflux`, one generation) and ask.
Never quietly substitute a hand-coded placeholder, a solid rectangle or an emoji
for the image that was asked for — an unannounced substitution is the one
outcome nobody can act on.

## The rule everything else follows from

**PixelLab draws material. This project owns geometry.**

A flat tile is the untilted pointy-top hexagon on a `width × flatHeight` canvas,
a surface is that hexagon squashed to the grid's tilt, and an elevation image is
the two side faces *alone* — a band that follows the `V` its lower edges cut
(`docs/content-format.md`, ADR-0026/0037/0041). PixelLab knows none of that, and
an image that misses it fails `scripts/tile-art.test.mjs`, draws a seam at every
cliff foot, or shows the background through the ground.

So nothing generated is written into `assets/tiles/` directly. It comes through this
skill's own `scripts/conform.mjs`, which scales it to the canvas the tile set
declares, closes any hole, and masks it to the exact shape the renderer draws.

And never re-run `scripts/generate-tile-art.mjs` to fix a generated tile: it is
a **seeder, not a pipeline**, and it rewrites all 184 shipped images.

## 1. Spend deliberately

Generations are the user's money, and some tools cost forty of them a call.

```text
get_balance
```

Read it **before the first call of a session** and say what it says. A trial
allowance is 40 generations in total — one `create_image_pro` can be all of it.

| Call | Cost |
|---|---|
| `create_image_pixflux`, `create_image_pixen` | 1 generation |
| `create_character` (standard/v3), template `animate_character` | ~1 per direction |
| `create_topdown_tileset`, `create_sidescroller_tileset`, `create_tiles_pro`, `create_isometric_tile`, `create_path_tiles`, `create_building_kit` | a few — not documented per call, so watch `get_balance` around the first one |
| `create_image_pro`, `create_1_direction_object`, `create_8_direction_object`, `create_ui_asset`, `create_font`, `edit_image`, `inpaint_image`, `create_character_state`, pro animations | 20–40 generations |

Then:

- a 20–40 generation call is a **decision**: name it, name its cost, get a yes;
- **one before eight** — generate a single variant, conform it, look at it, and
  only then spend on the other seven;
- `list_jobs` before queueing more, `cancel_job` on a mistake — a cancelled job
  is cheaper than a discarded result;
- every creation tool returns a job and polls through its `get_*` twin
  (`get_image`, `get_character`, `get_tiles_pro`, …). Expect 15 s for a tile,
  2–5 minutes for a character. Do something else while it runs; do not
  re-queue it because it is slow.

## 2. Which directory the file lands in

Two content directories exist and confusing them is the classic mistake
(ADR-0019):

| Directory | What it is | When art goes there |
|---|---|---|
| `INSULAIRE_CONTENT_DIR` (`.env`) | the **workspace**: the game being authored | by default — this is where new art belongs |
| `content/` at the repo root | the **fixture**: the minimum valid project the tests read | only when asked for, and it must stay green |

`conform.mjs` resolves the same `contentDir()` the dev server does and prints
which one it wrote to. Read that line rather than assuming.

That split governs **game content**. An image with another home — a README
banner, an illustration for `docs/`, a desktop icon under
`apps/desktop/icons/`, a rough that is only being looked at — goes to that home
instead: pass an absolute path, and put anything provisional in the scratchpad
rather than in either content directory.

Fixture art is shipped code: `node --test scripts/tile-art.test.mjs` covers it,
the smoke baseline has screenshots of it, and changing it means the
`verify-no-regression` skill and a version bump. Workspace art commits in the
workspace's own repository.

## 3. The house style

Every prompt carries the same preamble, or the set stops looking like one set:

```text
Top-down pixel art tile for a hexagonal map. Flat, even lighting with no
gradient across the tile and no darkened rim. Variation is fine-grained
mottling a few pixels wide plus scattered detail. Limited palette, hard pixel
edges, no anti-aliasing, no outline around the tile.
```

The rules behind it, which are contract rather than taste:

- **No gradient, no rim, on anything laid edge to edge.** Six hexes meet on a
  map: a light-to-dark ramp inside one becomes a diagonal seam across the field
  and a shaded border becomes a honeycomb.
- **Light comes from the upper left.** The seeder lights every face that way —
  on a raised hex the south-west face is lit and the south-east one is in
  shadow.
- **Cut ground is where light models anything**: strata parallel to the edge
  above, erosion running down, stones the size the material carries, a hard
  shadow under the overhang.
- **A sprite that will be tinted must be pale.** A tint *multiplies* and keeps
  alpha (`docs/content-format.md`), so hair, cloth or anything a parameter
  recolours is generated near-white with its shading intact — one greyscale
  sprite serves every colour.

The shipped palette, if a prompt should name colours:

| Terrain | deep | base | light |
|---|---|---|---|
| grass | `#3f5e22` | `#55792a` | `#7ba23b` |
| earth / dirt | `#634628` | `#7c5933` | `#9e784a` |
| sand | `#b0945c` | `#c9af76` | `#e3ce9d` |
| water | `#1a486d` | `#1f537b` | `#2a6692` |
| undergrowth | `#1a2e18` | `#233c1e` | `#335529` |
| canopy | `#244422` | `#335c2c` | `#558b3f` |
| rock | `#4c4945` | `#67635e` | `#8f8a83` |
| mountain | `#39383e` | `#4e4d54` | `#72717a` |

**Consistency across calls is a parameter, not a hope.** Pass an image already
in the set as `style_image_url` / `style_images`, chain tilesets through
`base_tile_id` / `lower_base_tile_id`, and reuse `seed` when a variant should
stay close to its sibling. A second tile prompted from scratch lands in a
different world from the first.

## 4. What draws what

| You need | Call | Then |
|---|---|---|
| a flat hex tile (`topDown` worlds) | `create_tiles_pro` with `tile_type: "hex_pointy"`, `tile_size: 64`, `tile_view: "top-down"`, `outline_mode: "segmentation"` | `conform flat` |
| one terrain material, cheaply | `create_image_pixflux`, 128×128, `no_background: false` | `conform flat` **and** `conform surface` from the same image |
| a surface (isometric top face) | the same material image | `conform surface` |
| a cliff band (an `elevation` level) | `create_image_pixflux`, `view: "side"`, ~64×32, describing a cut bank of strata | `conform elevation` — then look at it |
| a variant of a tile that already works | `edit_image` on the shipped PNG, or the same prompt with a new `seed` | the same conform shape |
| a character layer (sleeve, hair, boot) | `create_image_pixflux`, `no_background: true`, at roughly the layer's box | `conform sprite --size WxH` |
| a whole character, as reference | `create_character` (`mode: "v3"`, `n_directions: 4`) | **reference only** — see below |
| a portrait | `create_portrait_character` | `conform sprite` |
| a title background | `create_image_pro` (expensive) or `create_image_pixflux` | none — `assets/images/…`, any size |
| a README banner, a doc illustration, a rough | `create_image_pixflux` (1 generation), `width`/`height` to taste | none — save it where it belongs |
| an app or desktop icon | `create_image_pixflux`, square, `no_background: true` | `conform sprite` if a fixed box is wanted |
| a UI panel or a font | `create_ui_asset`, `create_font` | nothing in the format reads these yet |

Three things this project does **not** take from PixelLab as-is:

- **`create_character` output.** A character here is a paper doll: a tree of
  layers, each a small sprite placed from a joint, with variants chosen by
  parameters and moved by animations (ADR-0024/0031/0034). A finished
  four-direction sprite sheet has no way into that. Use it as the drawing to
  cut layers from, or to check a silhouette — not as an asset.
- **Objects and props.** `create_map_object` and `create_1_direction_object`
  draw them well, but a world's entities resolve against a built-in
  `templateId` registry (`player`, `monster`) and no field points at a prop
  image. A prop that must appear on a map today is authored as a
  `CharacterDefinition` with one layer and `category: "other"`.
- **`create_topdown_tileset`.** Its Wang tiles are square and corner-based; this
  engine is pointy-top hexes with authored transitions. It is the wrong shape,
  not a cheaper path to the right one.

## 5. Conform

```bash
node .claude/skills/generate-images-with-pixellab/scripts/conform.mjs \
  flat "<url-from-pixellab>" assets/tiles/grass/flat/grass_a.png
```

```text
conform.mjs <flat|surface|elevation|sprite> <source> <destination> [options]
conform.mjs inspect <source>
```

The source is the `https://` URL a PixelLab result carries, a `.png` path, or a
file holding base64 — write the inline base64 of an MCP result to a scratch file
and pass that. The destination is a path under the content root, or an absolute
path for an image that lives anywhere else.

`sprite --no-trim` with no `--size` is the plain form: it downloads, re-encodes
to 8-bit RGBA and writes, without touching a pixel. That is the shape for
anything that has no geometry to honour.

| Option | Meaning |
|---|---|
| `--tile-set <path>` | Geometry source. Default: the only tile set `project.json` declares. |
| `--fit cover\|contain\|none` | How the source meets the canvas. Default `cover`. |
| `--offset <dx,dy>` | Slides the source inside the canvas, in destination pixels. |
| `--fill <#rrggbb>` | Backdrop behind a tile shape. Default: the source's most common colour. |
| `--size <w>x<h>` | `sprite` only: fit to this box. |
| `--no-trim` | `sprite` only: keep the transparent border. |
| `--force` | Overwrite an existing file. |

What it guarantees, so it does not have to be re-checked by eye:

- the canvas is exactly what the tile set's `art` block declares;
- a tile is opaque inside its silhouette and empty outside it — no hole, no
  overhang;
- an elevation band is `elevationHeight − surfaceHeight / 4` rows tall and
  follows the `V`, column by column, which is what
  `scripts/tile-art.test.mjs` asserts;
- scaling is nearest-neighbour only. Never a smooth resample: an interpolated
  pixel is a colour nobody chose.

Those guarantees are pinned by a test — run it after touching the tool:

```bash
node --test .claude/skills/generate-images-with-pixellab/scripts/conform.test.mjs
```

`inspect` prints size, opaque box and colour count — worth a look before
conforming something that came back at an odd size.

For `sprite` it prints the box it wrote, which is the `width`/`height` half of
the `rect` the character definition owes it; `x`/`y` are measured from the joint
the layer hangs off (ADR-0024) and are commonly negative.

## 6. Wire it into the content

- **A tile variant** is an entry in the tile's `art.flat`, `art.surface` or
  `art.elevation.levels[].variants`, with an id unique in its list (`a`…`h` by
  convention, 16 at most). Flats and surfaces of the same id should be the same
  material — that is the point of conforming one image into both.
- **A character layer** is a variant with its `rect` and `sprite.asset`, and a
  `when` if it is conditional; most specific first, because the first match wins.
- **Neither is a schema change**, so no version bump on the tile set or the
  character format. Adding a *field* would be — then `docs/content-format.md`
  and the schema constant move with it (`.claude/rules/specs.md`).
- The dev server serves the workspace live: reload the page, do not rebuild.

## 7. Prove it

1. `node --test scripts/tile-art.test.mjs` — the silhouette contract. It reads
   the **fixture** only; workspace art is proven by the conform guarantees plus
   looking at it.
2. Look at it: `just run`, then the asset editor for the image and the map for
   the field of them. A tile is wrong in ways a test cannot see — a seam, a
   repeat that reads as a grid, one variant brighter than its siblings.
3. If anything in the repository moved, `npm run check`, then the
   `verify-no-regression` skill before committing; new fixture art changes
   screenshots, so the baseline is re-accepted deliberately, never blindly.

## 8. Provenance

A generated image is not reproducible from itself: the prompt, the tool and the
ids are the only way to make a sibling that matches it later. Append one line
per asset to `assets/pixellab.jsonl` under the content root:

```bash
echo '{"asset":"assets/tiles/grass/flat/grass_a.png","tool":"create_tiles_pro","id":"<tile_id>","prompt":"...","seed":1234,"date":"2026-08-21"}' \
  >> /root/baneims_son/content/assets/pixellab.jsonl   # the root conform.mjs printed
```

Nothing reads that file — the content loader only opens what `project.json`
declares — which is exactly why it is safe to keep next to the art.

Say in the commit message that the art was generated and with which tool. The
repository is GPL-3.0: anything committed has to be redistributable under it, so
check the terms of the plan in force (https://pixellab.ai/termsofservice) before
shipping generated art, not after.

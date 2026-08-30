# ADR-0028 — One Editor for Everything the Game Is Drawn From

## Status
Accepted

## Context

**Two editors were painting pixels, and neither knew the other existed.** The
character screen composed a figure and painted it — pencil, eraser, eyedropper, a
palette ranked by use, undo — inside a 2594-line component that also held the
layer tree, the variant forms, the parameter list and the animation stage. The
asset screen browsed a tile set and painted it — pencil, eraser, fill,
eyedropper, a movable rectangular selection, an alpha — in a 546-line component.
Both edited the same `SpriteDocument`: the same framework-free RGBA buffer, the
same bounded undo, the same palette arithmetic. They differed in tools not
because a tile needs different tools than a cape does, but because the second was
written eighteen months of decisions after the first. An author who had learned
to fill a shoreline could not fill a boot.

**The asset browser advertised a `Personnages` row with nothing behind it**,
promising a *second* place to author a character, which nobody wanted.

**The tile screen's centre column was already too small**, and it did not scale a
preview down when the column was short — it clipped it, silently. A tile survives
that because there is not much to look at. A character is a tall narrow figure
that must be judged whole, at the zoom the game draws it, beside a layer tree, a
variant form and a timeline.

Underneath sat an older question: where do the images come from at all? Arranging
sprites without being able to draw them leaves a gap through the middle of
authoring a character. A body is 22×107 pixels; whether a cape sits on its
shoulders is a matter of two or three pixels, and the only place that is
answerable is the composed figure at the zoom the game draws it. The loop the
editor implied was: leave, open a pixel editor, guess, export, upload, look,
guess again. Two smaller things pull the same way — a tinted sprite cannot be
edited honestly elsewhere, because in another tool an author is matching greys
while in the game they are matching browns; and nothing keeps two layers on one
palette, which is most of what makes a composed figure read as assembled rather
than drawn.

Against that stands one real objection: a pixel editor is a serious piece of
software, and this project has no business rebuilding Aseprite in a tab.

Three answers were rejected. **Delete the `Personnages` row** — honest, cheap,
and it leaves two paint stacks, two palettes, two undo histories and every future
tool owing a decision about which to land in. **Share the pixel editor, keep two
modules** removes the duplicated code and none of the confusion. **One page for
everything** merges two components of 946 and 2594 lines into the screen nobody
dares to change: the unit to share is the *frame* and the *tools*, not the
document logic, because a tile set and a character library are genuinely
different documents.

## Decision

**`/editor/asset` is the only place pixels are authored, and a category is a
route under it.**

```text
/editor/asset/tiles        TileWorkspace        available   (ADR-0026)
/editor/asset/characters   CharacterWorkspace   available   (ADR-0024, ADR-0025)
/editor/asset/decorations  DecorationWorkspace  available   (ADR-0035)
/editor/asset/objects      ObjectWorkspace      available   (ADR-0036)
/editor/asset/effects      planned
```

`character` leaves `EDITOR_MODULES`. The project is pre-1.0, so `/editor/character`
is **gone**, not redirected. `ASSET_CATEGORIES` becomes what `EDITOR_MODULES` is
one level up: the single list the child routes, the rail and the planned-category
page all read.

**A category owns its document; the module owns the frame.** `AssetEditorPage`
holds the category rail and a `router-outlet` and knows nothing about tiles or
characters. Each workspace keeps its own file, toolbar, validation and list — the
two documents were never the duplication.

**The preview is the drawing surface.** The stage that composes a character also
paints it, and a tile is painted on its hexagon. There is no second flat copy
beside it, because two surfaces showing the same pixels means neither is large
enough and the author has to decide which to look at.

**This is a retouching tool, not a pixel editor.** It owns the last three pixels
— the ones only judgeable against the rest of the figure. Sharing the toolbar
forced the question of which toolbar was right, and the answer was the smaller
one: **the fill and the movable selection are removed**, from the buttons, from
`sprite-document.ts` and from the tests. A pencil, an eraser and an eyedropper are
what retouching in place needs. When a job needs more, the answer is a real pixel
editor and the upload button ADR-0019 provides — not a bigger tool here. **The
alpha stays**: it is a property of a pixel, not a tool, and it costs one slider.

**It stays in TypeScript, and nothing crosses the boundary.** Rust owns what a
character *is*; a pixel is authoring, not a rule. The core is
`apps/web/src/content/sprite-document.ts`: a framework-free RGBA buffer with
painting, a bounded undo history and the palette, all plain arithmetic. Only
three edges touch the DOM — decoding an image, showing the buffer, encoding the
PNG — which is why the interesting half is unit-tested without a canvas.

**You paint the file, not the composite.** The open layer is drawn **without its
tint** at all times, so what the pencil writes is what the file holds and two
greys are compared as two greys. Every other layer keeps its tint, because the
point of painting here is the figure around it.

**Whole pixels, and whole alpha by default.** A painted pixel is opaque, an
erased one fully clear, and a drag is joined into a line. Partial alpha is the
author's to ask for: the original prohibition was a claim about the tint
pipeline, and the tint is now exact — the multiply is per-pixel over the RGB with
the alpha carried through — so a pixel at half alpha is the shade it was drawn
as, at half alpha. With that fixed, forbidding a soft edge is a matter of taste
an ADR has no business enforcing.

**The palette is made of the drawing.** Colours are ranked by how much of every
sprite the character draws uses each, then by what was picked recently. No fixed
ramp, because the tones that matter are the ones already on the figure.

**There is no paint mode.** Every surface always paints. What a *drag* does on the
character stage is decided by the open inspector panel — the animation editor in
front of you means you are placing a limb, anything else means you are drawing —
and the hint under the stage says which.

**The zoom is a whole number, a pointer is measured against the element, and a
box that is not the image's own size refuses to be painted.** The interface scale
zooms the whole shell, so trusting the layout puts every click off by that factor;
`pixelUnder()` divides the drawn box by the rendered one and sits next to
`placement()`, whose inverse it is. Painting through a stretch would land every
stroke on a pixel the author did not point at, so the editor offers *Fit to image*
instead of guessing. A layer with no image can make one — a transparent PNG the
size of its box.

**Pixels are written as PNG through the authoring workspace** (ADR-0019), on
their own button and again whenever the definition is saved: art and definition
are one act of authoring. Until then they live in the tab, and the undo history
is never persisted.

**What a category supplies is the guides drawn behind the pixels** — a tile's
hexagon geometry, or none at all — so the surface never learns what it is drawing.

## Consequences

Positive:
- there is one answer to "where do I draw", and it is the same for a tile, a cape
  and, later, a torch;
- the loop closes: place, paint, look at the whole figure, adjust — one screen,
  at the zoom the game uses;
- a tinted sprite is finally editable by the person who chose the tint, and a
  character keeps one palette because the palette *is* the character;
- the tools stop diverging by accident: one component, one toolbar, one palette
  model, one undo, and the next tool lands once;
- a character is editable at full height, which is the case that failed before;
- the sprite buffer is ordinary data, so undo, the palette and the line-join are
  tested as arithmetic rather than as a browser;
- `EDITOR_MODULES` gets shorter while the editor gets larger, which is the shape
  ADR-0016 wanted: modules are domains, not screens.

Negative:
- **unsaved pixels live in a browser tab.** Closing it is guarded by the browser's
  own prompt and the count is on screen, but navigating inside the application is
  not guarded;
- the undo history is bounded at 32 strokes and dies with the page;
- **the stage must agree with the renderer on every pixel** or a click lands next
  to the pointer. `placement()` and `pixelUnder()` are load-bearing, and
  everything that scales the page passes through them;
- **`/editor/character` is a dead URL**, and pre-1.0 that is the deliberate answer
  rather than a redirect;
- a second way to change content that Rust never sees: an image's *size* is
  authored here, and only *fit to image* keeps it and the box in step;
- **a fill and a selection existed and were taken away.** Anyone who used them on
  a tile has lost them;
- **a tile has no flat pixel view any more** — right for a surface, less obviously
  right for an elevation face seen at an angle;
- two scene modes for characters is a mode, with a mode's cost;
- the inspector's width, the zoom and the grid die with the tab.

## Rule

Everything the game is drawn from is authored in the asset editor, one category
per kind, in one frame with one set of pixel tools. A category owns its document;
it does not own a palette, an undo history, a pencil or a layout. A new kind of
drawn thing is a new category — never a new screen. Pixels are authoring, not
content rules: they live in TypeScript and reach the engine only as files.

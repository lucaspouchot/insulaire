# ADR-0030 — The Editor Paints the Sprites It Composes

## Status
Accepted. Extends `docs/adr/ADR-0029-characters-are-composed-sprites.md`, which
decided what a character is drawn *from*; this decides where those images are
made. No schema, no engine boundary and no content file changes shape.

## Context

ADR-0029 gave the editor everything needed to **arrange** sprites: pick an image
from the content directory or upload one, fit the layer's box to it, bind a
tint, and watch the figure compose. Everything except the images themselves.

That leaves a gap through the middle of authoring a character. A body is 22×107
pixels; whether a cape sits on its shoulders is a matter of two or three pixels,
and the only place that question is answerable is the composed figure, at the
zoom the game draws it. The workflow the editor implied was: leave, open a pixel
editor, guess, export, upload, look, guess again. The loop where the question is
asked and the loop where it is answered were different applications.

Two smaller things pull the same way.

**A tinted sprite cannot be edited elsewhere honestly.** Hair is authored
near-white and multiplied by the chosen colour. In another tool an author is
matching greys; in the game they are matching browns. The shading that reads
right in one reads wrong in the other, and nothing tells them which.

**Nothing keeps two layers on one palette.** The boot brown and the belt brown
drift apart when they are picked in separate sittings, weeks apart, out of a
system colour wheel. That drift is most of what makes a composed figure read as
assembled rather than drawn.

Against all of that stands one real objection: a pixel editor is a serious piece
of software, and this project has no business rebuilding Aseprite in a tab.

## Decision

**The preview is the drawing surface.** The stage that composes the character
also paints it: pencil, eraser, eyedropper, a palette, a whole-number zoom, and
undo. What it edits is the image behind the layer currently open in the variant
form — the one already outlined on the stage.

This is a **retouching tool, not a pixel editor**. It owns the last three
pixels: the ones you can only judge against the rest of the figure. It has no
selection, no sub-layers, no brush size, no opacity, no fill and no animation.
When a job needs those, the answer is a real pixel editor and the upload button
ADR-0022 already provides — not a bigger tool here.

**It stays in TypeScript, and nothing crosses the boundary.** Rust owns what a
character *is*; a pixel is authoring, not a rule (`CLAUDE.md`). The core is
`apps/web/src/content/sprite-document.ts`: a framework-free RGBA buffer with
painting, a bounded undo history and the palette, all plain arithmetic. Only
three edges touch the DOM — decoding an image, showing the buffer, encoding the
PNG — which is why the interesting half is unit-tested without a canvas.

**You paint the file, not the composite.** While painting, the edited layer is
drawn **without its tint**. What the pencil writes is what the file holds, so
two greys are compared as two greys. Every other layer keeps its tint, because
the point of painting here is the figure around it.

**Whole pixels, whole alpha.** A painted pixel is opaque, an erased one is fully
clear, and a drag is joined into a line so a fast pointer does not draw dots.
Partial alpha would survive into the tint pipeline as a soft edge that no
recolouring can fix.

**The palette is made of the drawing.** Turning paint mode on opens every sprite
the character draws, and colours are ranked by how much of all of them use each
— not only the sprite in hand — then by what was picked recently. No fixed ramp,
because the tones that matter are the ones already on the figure. Alt takes the
colour under the pointer without leaving the pencil.

**The zoom is a whole number and the stage scrolls.** The same rule as ADR-0029,
for the same reason: at a fractional zoom the pixel under the pointer is not the
pixel that gets painted. The stage is capped so a 256-canvas cannot ask a tab
for a hundred megabytes.

**Transparency is drawn in authored pixels, not screen pixels.** The checker
behind a sprite is painted on the canvas, one square per authored pixel — two
where one would be too small to see — so it reads as the grid being painted on
and zooms with it. A CSS background, which is what it used to be, is a fixed
number of screen pixels and puts a second grid on the stage at a scale that
contradicts the first.

**A pointer is measured against the element, never against the layout.** The
interface scale zooms the whole shell (`app/app.css`), so the box a pointer is
reported in has been multiplied while the box the stage drew in has not.
Trusting the layout puts every click that factor off — further off the further
it is from the canvas's corner, which reads as a click that lands *near* where
you pointed. `pixelUnder()` divides the drawn box by the rendered one, and sits
next to `placement()`, whose inverse it is, so the two cannot drift apart. The
backing store follows the same measurement, or a scaled shell would resample
the sprites this pipeline exists not to resample.

**A box that is not the image's own size refuses to be painted.** Painting
through a stretch would land every stroke on a pixel the author did not point
at, so the editor says so and offers *Fit to image* instead of guessing.

**A layer with no image can make one**: a transparent PNG the size of its box,
named after the character, the layer and the variant. Without it the tools would
only ever retouch art made elsewhere, which is the wrong half of the job.

**Pixels are written as PNG through the authoring workspace** (ADR-0022), on
their own button and again whenever the definition is saved — art and definition
are one act of authoring. Until then they live in the tab; the undo history is
never persisted.

## Consequences

Positive:
- the loop closes: place, paint, look at the whole figure, adjust — one screen,
  at the zoom the game uses;
- a tinted sprite is finally editable by the person who chose the tint;
- a character keeps one palette because the palette *is* the character;
- a definition can go from nothing to a drawn figure without leaving the editor,
  which is what makes blocking one out cheap enough to actually do;
- the sprite buffer is ordinary data, so undo, the palette and the line-join are
  tested as arithmetic rather than as a browser.

Negative:
- **unsaved pixels live in a browser tab.** Closing it is guarded by the
  browser's own prompt and the count is on screen, but navigating inside the
  application is not guarded — the editor shows what is unwritten and trusts the
  author to write it;
- the undo history is bounded at 32 strokes and dies with the page;
- **the stage must agree with the renderer on every pixel** or a click lands
  next to the pointer. It is kept honest by asking `placement()` rather than
  duplicating it, and by reading the pointer back through `pixelUnder()`. That
  pair is load-bearing, and everything that scales the page — the interface
  scale, a browser zoom — passes through it;
- turning paint mode on decodes every sprite the character draws, to build the
  palette — cheap at these sizes, and the reason it is a mode rather than
  always on;
- a second way to change content that Rust never sees: an image's *size* is
  authored here, and only "fit to image" keeps it and the `rect` in step
  (ADR-0029 already recorded that the engine cannot validate this);
- no fill, no selection, no sheets — and each of those will be asked for.

## Rule

Pixels are authoring, not content rules: they live in TypeScript, on the screen
that composes them, and reach the engine only as files. The editor may paint the
images a character is drawn from; it may not decide anything about the character
that a validator could have.

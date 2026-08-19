# ADR-0029 — Characters Are Composed Sprites on a Declared Pixel Canvas

## Status
Accepted. Replaces the *rendering* half of
`docs/adr/ADR-0028-character-definitions.md`; everything else that ADR decided —
definitions, parameters, layers, variants, one resolver, one editor, no player
branch — stands unchanged.

## Context

ADR-0028 built the character system and gave it two rendering modes:
`procedural`, where a layer is a rectangle, an ellipse or a triangle filled with
one colour, and `assetComposition`, where a layer is an image. Geometry was a
unit square — floats in `0..1` — so one definition could be drawn at any size.

That was the wrong shape for the game being built. The characters this project
wants are pixel art: a body, a cape, hair, boots, each a small PNG, combined
into a figure a few dozen pixels tall. Against that goal the previous decision
is wrong twice.

**Unit-square geometry cannot place a sprite.** `0.38 × 64 = 24.32` — a third of
a pixel of drift, which is a seam between two layers drawn to touch, and a
different seam at every zoom. Pixel art is placed in pixels or it is not placed.

**One-colour primitives are not a rendering mode**, they are a blockout tool
that had been promoted to an architecture. Keeping them meant two vocabularies,
two validators, two editors and a `rendering` field whose only job was to stop
an author mixing them.

There was a third thing the old model handled badly. A character with a hair
colour needs either one sprite per colour — twelve images that must be redrawn
together — or a way to recolour one sprite. The colour binding of ADR-0028 could
only fill a shape, so with images it did nothing.

## Decision

**A layer draws a sprite. That is the only thing a layer can draw.**

`LayerVisual` and its `Shape` case are gone, and so is `RenderingMode`: there is
one mode, so there is nothing to declare and nothing to hold an author to. A
variant carries a `sprite { asset, tint? }`.

**A definition declares its canvas**: `resolution { width, height }`, at most
256 a side, chosen by whoever authors the character. Every layer box is a
position on *that* grid.

**Geometry is whole pixels.** `PixelRect` is `[x, y, width, height]` in canvas
pixels; `x` and `y` may be negative so a cape can overhang. The box should be
the image's own size, and the editor fills it in from the image when one is
picked, because any other size stretches the art.

**The canvas is what a character's size is.** `scaleParameter` is gone with the
unit square. A rat is authored at 32×32 and a dragon at 256×256; a host draws
each at its native size times a **whole-number zoom**, computed from the box it
was given. There is no fractional scale anywhere in the pipeline, because a
fractional scale is how pixel art stops being pixel art.

**A tint recolours a sprite**, fixed or read off a parameter — the colour
binding of ADR-0028, moved from filling a shape to multiplying an image and
restoring its alpha. A near-white sprite becomes the tint with its own shading
intact, so *one* greyscale hair sprite serves every hair colour. This is what
makes a parameter change what is drawn without multiplying the art.

**A missing sprite draws as a dashed outline**, and that is the blockout tool
the primitives were pretending to be: a layer can be positioned on the canvas
before any art exists, and a new definition starts as two placed, unpainted
layers.

**The editor gains the asset workflow**: pick an image from the content
directory or upload one into it (the door ADR-0022 already opened), fit the box
to the image, bind a tint, and see the canvas bounds and the selected layer's
box drawn over the preview.

## Consequences

Positive:
- the format says what a pixel-art character actually is, and a diff of "the
  hair moved up two pixels" reads as `"rect": [23, 8, …]` instead of a float;
- one vocabulary, one validator, one variant editor — the `rendering` field and
  every check that enforced it are gone;
- tinting turns "hair colour" into one sprite instead of twelve, which is the
  difference between a parameter being usable and being theoretical;
- sizes compose honestly: a 32×32 goblin next to a 128×128 knight needs no
  per-character scale;
- the renderer is smaller and its output is exact — no smoothing, integer
  destinations, whole-number zoom.

Negative:
- **a breaking content change**: every `visual` becomes a `sprite`, every unit
  rect becomes pixels, and `rendering`/`scaleParameter` are dropped. Pre-1.0,
  and the one shipped definition moved with it, but any file written against
  ADR-0028 must be rewritten;
- a character can no longer be drawn without art at all — an unpainted layer is
  an outline, which is enough to place it and not enough to look at;
- nothing scales *within* a definition, so a "tall" and a "short" variant of the
  same character are two sets of sprites, not a slider;
- the canvas is a hard cap at 256, so a character that wants more is a code
  change and an ADR;
- an authored `rect` that disagrees with its image's real size stretches the
  sprite, and only the editor's "fit to image" defends against it — the engine
  never sees an image, so validation cannot.

## Rule

A character layer draws an image, placed in whole pixels on the canvas its
definition declares, optionally tinted. No host resamples a character: the zoom
from canvas to screen is a whole number.

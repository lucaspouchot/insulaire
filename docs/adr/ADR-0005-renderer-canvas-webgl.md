# ADR-0005 — Render the World to a Canvas, Not to the DOM

## Status
Accepted

## Context

A hex map can contain far more tiles than should ever be represented in the DOM.
One component per hex is the shape the framework invites and the shape that
cannot work: a 2048x2048 world is four million elements, each with a style, a
change detector and a layout cost, for a picture that is one draw call's worth of
pixels. `CLAUDE.md` names it as the first thing to avoid.

The interface around the world is the opposite case. A HUD, a panel, a form and a
dialog are exactly what a component tree is good at, and drawing them into a
canvas would mean re-implementing focus, text layout and accessibility.

## Decision

**The world is drawn to a `<canvas>`; everything around it is Angular.** The
boundary is the canvas element: inside it the renderer owns every pixel, outside
it components own the interface. No component represents a hex.

**The renderer earns its frame budget by not drawing what it does not have to.**
Viewport culling first, then batching by palette entry, then caching what two
cells can share (ADR-0027). Level of detail is available if it is ever needed and
is not implemented.

**User input is converted to hex coordinates and sent to the engine.** A pointer
event becomes a cell through the projection's exact inverse (ADR-0013), and what
happens next is a command, not a mutation (ADR-0010).

**Transport is a separate question from drawing.** Reducing requests for tile art
was solved with a bundle rather than a texture atlas, because the draw-time cost
was already bounded by sharing (ADR-0027). An atlas remains available if drawing
ever becomes the bottleneck.

## Consequences

Positive:
- rendering is decoupled from the DOM and from change detection, so map size
  costs pixels rather than elements;
- the renderer is ordinary TypeScript over a buffer, testable without a
  component fixture;
- the interface keeps everything a component tree gives it, because it never
  became canvas.

Negative:
- nothing inside the canvas is accessible to a screen reader or selectable as
  text, so anything a player must be able to read has to exist outside it;
- hit-testing is the renderer's job, and it must agree with what was drawn to the
  pixel — a class of bug that has no equivalent in the DOM;
- the canvas is 2D. A genuine WebGL path would be a rewrite of the draw layer,
  and nothing here has needed one.

## Rule

No Angular component represents a hex, an entity or anything else the renderer
draws. What is inside the canvas is drawn; what is outside it is a component.

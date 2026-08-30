# 07 — Lift the session presentation out of the play page

Status: needs-triage
Strength: worth exploring
Blocked by: —

## Problem

`apps/web/src/app/features/play/play-page.ts` is 921 lines, injects ten
dependencies, and has **no spec**. Four modules are fused into it:

- session lifecycle — `startGame`, `resumeGame`, `restart`
- content registration — `registerContent`
- **the animation clock** — `playerAnimation`, `entityMotions`,
  `presentationFrame`, `presentationSampledAt`, `warmedCharacterAssets`
- the event log — `logCounter`, `log`
- plus the canvas, the camera and the input

The third is pure computation. A snapshot and a timestamp go in; positions,
animation roles and interpolated motion come out. It has no reason to need a DOM,
and today it cannot be reached without one.

The contrast is in the same repository: `renderer/hex-map-renderer.ts` is 2,010
lines — the largest module in the app — and has a 1,325-line, 36-test spec,
because it is not an Angular class and takes a `CanvasRenderingContext2D` in its
constructor. The play page bundles logic that could be equally testable inside a
component that cannot be.

## Deepening

A session-presentation module: `frame(snapshot, timeMs) -> Drawable[]`. It owns
interpolation, animation-role selection, motion and log-entry construction. The
page keeps the canvas, the camera and the input.

## What this does not change

ADR-0023 already moved session *ownership* to the engine:

> The engine owns the session; the route only draws it. […] a component that ends
> the session when its canvas is disposed is a component behaving as though it
> owned it.

Session *presentation* stayed in the page. This ticket finishes that move. No
rule crosses into Angular — ADR-0010's rule ("Angular may not compute a rules
answer that the engine could give it") is unaffected, because interpolation
between two engine-supplied positions is presentation, not a rule.

## Open questions

- Where does the frame clock live — inside the module, or driven by the page?
  Driven by the page keeps the module pure and testable with a supplied `timeMs`.
- Does the editor's map preview use the same module? If yes, that is a second
  adapter and the seam is real rather than hypothetical.
- Does `renderer/render-model.ts` (the one renderer module with no spec) belong
  on this side of the seam?

## Done when

- `frame(snapshot, timeMs)` is exercised by a spec with no DOM.
- `play-page.ts` holds canvas, camera, input and lifecycle, and nothing that
  computes a position.
- The smoke run's screenshots are unchanged.
- `npm run check` passes.

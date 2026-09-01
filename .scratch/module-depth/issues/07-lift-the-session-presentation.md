# 07 — Lift the session presentation out of the play page

Status: done
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

## Decisions

**The page drives the clock**, as the question itself suggested. The module owns
the *rate* — `PRESENTATION_FRAME_MS`, a presentation fact — and the answer to
whether another sample would draw anything different (`changing`); the page owns
`requestAnimationFrame`, because a page already knows when it is on screen and
the module would only be guessing. Every method that reads time takes it as an
argument, which is what lets a spec say "half way through the step" as a number.

**No second adapter, and the seam is real anyway.** The editor's map preview
draws content, not a session: it has no snapshot, no tick and no glide between
two of them, so making it a second caller would mean inventing a session for it.
The evidence the seam is real is the spec — 15 tests over interpolation, role
selection, the hand-back to idle and the log, none of which could be reached
before without starting a browser.

**`renderer/render-model.ts` stays where it is.** It is the *shape* the renderer
draws from, shared by Play and by three editor screens; this module produces one
kind of member of it. Moving it would put the editor's model behind a play
session.

**The log came too.** It is one of the four the ticket names, and moving only its
`switch` would have left the counter, the cap and the newest-first order in the
page — three quarters of the fact in the place the ticket is emptying.

## Done when

- `frame(snapshot, timeMs)` is exercised by a spec with no DOM. ✔
  `session-presentation.spec.ts`, 15 tests, no `TestBed` and no canvas — the
  first spec this feature has ever had.
- `play-page.ts` holds canvas, camera, input and lifecycle, and nothing that
  computes a position. ✔ 918 lines to 714. What left: the animation state and
  its role selection, the entity motions and their interpolation, the resolved
  appearance and its asset warming, and the log. What stayed: the canvas, the
  camera, the input, the session lifecycle, the render model, and the
  `requestAnimationFrame` loop that samples the module.
- The smoke run's screenshots are unchanged. ✔ `clean`: transcript identical,
  no console errors, and the screens that differ are the frame-timing readout at
  canvas delta 0 — including `play-motion` and `play-motion-click-1`, which are
  the two that exercise a glide.
- `npm run check` passes. ✔

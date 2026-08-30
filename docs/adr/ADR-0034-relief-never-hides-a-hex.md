# ADR-0034 — Relief Never Hides a Hex

## Status
Accepted

## Context

An isometric world is drawn with `y' = y * tilt − z * elevationStep` (ADR-0013).
A raised cell moves *up* the screen, over the rows behind it, and the renderer
draws back to front so that it covers them. That is the point of the projection
and it is also its only real cost: with the shipped tile set a hex loses about a
third of its face to a neighbour raised three levels, and about nineteen
twentieths to one raised four. Beyond that it is gone — an author cannot see it,
and cannot click it either, because hit-testing has always resolved to the
frontmost cell drawn over the pointer. The report that opened this was exactly
that: *"il y a certaines cases qu'on ne voit pas et sur lesquelles on ne peut pas
cliquer"*.

Seeing and reaching are two different problems, and only one is hard.

**Seeing is free of consequence.** Nothing depends on it: showing what is behind
a mountain changes no state and resolves no click.

**Reaching is ambiguous, and no picture can resolve it.** The projection is not
injective. A cell raised four levels is drawn all but exactly on top of the cell
one row behind it, so a pixel names two hexes and nothing in the frame says which
one the pointer means. Every rule that picks one without extra input picks wrong
somewhere. *Frontmost wins* is what buries the hex behind. *The buried hex wins*
takes the pointer off the cell in front over almost the whole of its face, and
the back edge of a plateau kills it: its front neighbours stand at its own
height, so it has no cliff to aim at and no clickable area left. *The ground cell
under the cursor wins* is total and bijective, and makes a mountain reachable
only by its foot, which is where the picture says the mountain is not. So the
extra bit of intent has to come from the hand.

Several answers were tried or weighed and rejected. **Painting the buried hex
back over the relief**, clipped to its own hexagon, was built first: it is cheap
and it is wrong on screen, because the hex is *behind* the cliff and painting it
last puts it in front — it read as a green tile stuck onto a rock face. **`Alt`,
or any other modifier**, was also built first and is wrong in a browser: the
platform claims it for the menu bar and takes focus out of the game, and ADR-0032
excludes modifiers from the binding vocabulary on purpose. **A peek *mode***, a
toolbar toggle, survives the pointer leaving the canvas and is state that has to
be shown, remembered and cleared, and it puts the editor into a condition where
ordinary clicks silently mean something else. **Cycling through the stack** with
a wheel or repeated clicks makes the answer depend on history, and the wheel
already zooms. **Rotating the camera** gives up viewport culling, exact
hit-testing and the batching that ADR-0013 chose a diagonal transform to keep, to
solve a problem three numbers and a key solve.

## Decision

**A hex the relief hides is seen by drawing the relief see-through, and reached
with a held key the player binds.**

**Seeing works on the occluders, never on the hidden hex.** Depth in this
renderer is draw order, so anything that says "behind" has to be drawn earlier —
which leaves exactly one way to show it: draw less of what is in front.

**Buried is measured, and the same sweep names what buries it.** A cell is buried
when at least `BURIED_COVERAGE` — 75% — of its projected top face is covered by
the silhouettes of the cells in front of it. The measure is a lattice of sample
points trimmed to the hexagon, each standing for an equal patch, so the covered
fraction is the covered count; every candidate that claims a sample is recorded,
and *that* list is what is drawn see-through. Fading the cells whose pixels are
actually in the way, rather than a neighbourhood, is what keeps the rest of the
mountain intact. Only cells in front are considered, and the answer depends on
the elevation buffer alone and is memoised per model.

**The reveal follows the pointer, with no key held.** The frontmost buried hex
whose top face contains the pointer is revealed, together with the buried hexes
within `reveal.radius` rings of it.

**The two authored opacities are those of what stands in the way.**
`reveal.opacity` is how solidly the relief in front of the pointed-at hex is
drawn, `reveal.neighbourOpacity` the same for the ring; a cell in the way of both
takes the fainter. They belong to the map, because how tall a map's relief is
decides how much of it hides its own hexes. **Neither defaults to `0`**: a cell
drawn away entirely takes its silhouette with it, and where nothing stands behind
it that is a hole in the map rather than a hex seen through. Everything a faded
cell carries fades with it — grid outline, overlay, markers, whoever stands on it
— or the map is left with bright chrome floating over a gap.

**Reaching is a held binding.** `input.peek` is an application shortcut declared
beside the six movement positions, a modifier-free `KeyboardEvent.code` exactly
as ADR-0032 requires, defaulting to `KeyS` — the middle of that cluster, so the
hand that walks can hold it while the other points. Held, the pointer resolves to
the buried hex instead of the relief in front of it: hover, click, drag, paint.
Released, every existing click resolves exactly as it did. That the binding is
*held* rather than struck is a use of ADR-0032's vocabulary, not a change to it.

**The state comes off the keyboard, never off the pointer.** A hand pressing the
key over a still pointer sends no pointer event, so `CanvasView` listens on the
window — a canvas is not focusable — and re-resolves in place. It ignores the key
while a form field has it, ignores it inside a chord, and releases it on `blur`
and on a rebind, because a key whose `keyup` never arrives would leave the map
holding it down. `HexMapRenderer.resolvePointer` returns both answers at once —
what a click lands on, and what is buried there — because they are two questions
about one point.

`WORLD_SCHEMA_VERSION` is 5.

## Consequences

Positive:
- **no hex is unreachable.** Whatever a map's relief does, the peek key plus the
  pointer names any hex whose face is drawn anywhere — on a key the player chose,
  so a layout or a browser that eats one is not the end of it;
- depth still reads: what shows through a faded cliff is the pixels painted
  behind it, in the order they were painted, so the hex is seen where it is
  rather than pasted where it is not;
- nothing that worked changes. Without the key the hit test is the ADR-0013 one,
  cell for cell; with nothing revealed the fade map is empty and every batch is
  the batch it was;
- the cost follows the pointer, not the map: one coverage measurement per
  revealed hex per model;
- an author tunes it in the file — `reveal` is three numbers next to `grid`,
  validated in Rust like every other authored presentation value.

Negative:
- **a faded cell leaves the batches.** Opacity is per cell and a `Path2D` is per
  palette entry, so a see-through cell is drawn on its own at the end of its
  band. There are only ever a handful;
- **a key has to be discovered.** It is listed in Settings › Controls and the map
  settings hint points there, but nothing on the map says so;
- **the threshold is a judgement.** 75% is where a face stops being something a
  hand can aim at with the shipped geometry; a map whose art has a much shorter
  step will bury cells later than an author expects;
- **a faded cell is faded whole.** The see-through patch is a cell, not a hex
  window, so more of the cliff goes translucent than strictly needed — and an
  opacity near `0` shows the void behind an edge cell. Clipping the fade to the
  buried hexagons would fix it, at an inverse clip and a second draw per occluder
  per opacity, for a patch the eye already reads;
- one more universal binding, and `keyboard-shortcuts.ts` moves from
  `app/settings/` to `core/` so the framework-free canvas view may read a code.

## Rule

The key that reaches a hidden hex is a **binding, held** — never a modifier, and
never read off a pointer event. A hex hidden by relief is **seen** without asking
and **reached** by asking, and it is seen by drawing *what is in front of it*
fainter — never by drawing it over what is in front of it. Whether a hex is
buried is measured against its drawn face, never assumed from an elevation
difference. The frontmost cell stays what an unmodified click resolves to.

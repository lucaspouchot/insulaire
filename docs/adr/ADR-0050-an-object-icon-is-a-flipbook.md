# ADR-0050 — An Object Icon Is a Flipbook

## Status
Accepted. Amends `docs/adr/ADR-0049-an-object-is-carried-not-placed.md`, which
gave an object a single `icon` path and said it has "no frames". It has frames.
Everything else ADR-0049 decided — flat, no effects, keys for what the player
reads — stands. `OBJECT_SCHEMA_VERSION` goes to `2`.

## Context

**ADR-0049 refused frames for the wrong reason.** It refused them because an
object is not a decoration: no anchor, no plane, no order, nothing that comes
from sharing a hex. That argument is sound and unchanged. But "does not share a
cell" does not imply "does not move", and the ADR quietly turned the second into
the first.

Two things made that visible.

**An object with one PNG cannot be authored without leaving the editor.** The
object screen had one path field, an upload button, and a *Create* button
hidden under an empty canvas. The decoration screen, next door, has a frame per
row — each with its own *paint this* button — so a decoration is drawn where it
is defined and an object only *looked* like it was. Two categories of the same
editor answered "where does the picture come from?" differently
(`docs/adr/ADR-0039-one-editor-for-everything-drawn.md`).

**A glinting gem is an ordinary object.** A pulsing rune, a flickering torch in
the bag, a rotating coin: none of these needs an anchor or a plane, and every
one of them needs a second image. Under one `icon` the only ways to get there
were a sprite sheet the format cannot slice, or a `decoration` filed as an
object — which is exactly the confusion ADR-0049 was written to end.

Two shapes were rejected.

**Keep `icon`, add `animations` beside it.** Backwards compatible and wrong: two
fields that answer the same question, a validator that has to rule on which wins,
and a still icon that can be spelled two ways.

**Give an object the decoration's *named* animations.** A chest has `closed` and
`open`; a potion has nothing to name. Named states on an object would be an id
that is `idle` in every file in the project, and a picker to choose between one
thing.

## Decision

**An object's picture is a flipbook, flattened onto the definition.** No list of
named appearances — an object has exactly one, so it is three fields rather
than an array of objects:

```json
{
  "id": "gem", "schemaVersion": 2,
  "frames": ["assets/objects/gem_0.png", "assets/objects/gem_1.png"],
  "frameDurationMs": 100,
  "looping": true,
  "resolution": { "width": 16, "height": 16 }
}
```

**One frame is a still icon**, which is what nearly every object is. The
serialiser writes no `frameDurationMs` and no `looping` for one — a still
drawing has no rate to state and nothing to loop — so a potion file is no longer
than it was before this ADR.

**It is the same flipbook a decoration plays.** The arithmetic — how long a play
takes, which frame a millisecond falls in, that a loop wraps and a one-shot
holds its last frame — is written once in `crates/world/src/animation.rs` and
called by both. `MAX_DECORATION_FRAMES` became `MAX_FLIPBOOK_FRAMES` in that
move: the cap was never about decorations, it was about one PNG per frame.

**The resolver crosses the boundary, as a decoration's does.** `resolveObject`
and `previewObject` return a `ResolvedObject` — the frame index and the path
already chosen — so an inventory panel and the editor's preview cannot disagree
about which drawing is on screen (`docs/adr/ADR-0028-character-definitions.md`).

**No frame is a warning; an empty frame is an error.** `object.noFrames` keeps
ADR-0049's promise that an object may be blocked out before its art exists and
still save. A frame that names *nothing* is a row an author left half-filled,
and that is `object.missingFrame`.

**`schemaVersion` is `2`, and nothing reads `icon`.** The project is pre-1.0 and
ships no object content, so the old field is dropped rather than aliased
(`CLAUDE.md`). An object file written against `1` loads with an empty icon.

## Consequences

Positive:

- an object is authored end to end inside the editor: *new object*, *paint a
  32×32 icon*, draw. No PNG has to exist first, in either category;
- an animated icon costs one more row, and the file stays readable — one frame
  per line, so a changed drawing is a changed line;
- one flipbook implementation, so a decoration and an object cannot drift on
  what plays at 250ms;
- the two asset screens now answer "where does the picture come from?" the same
  way, which is what ADR-0039 claimed they already did.

Negative:

- **a second way to animate is now in a second format.** A character animates by
  skeleton, a decoration and an object by flipbook, and an author has to know
  which they are editing. This ADR widens that split rather than closing it;
- **`frames` is flat, so an object can never have states.** If equipment ever
  needs a worn-versus-carried picture, this decision is in the way, and the fix
  is the decoration's shape — a named list — which is a schema change, not a
  field;
- **nothing plays an object icon yet.** There is no inventory panel, so the only
  place a flipbook runs is the editor's own preview. `frameDurationMs` and
  `looping` are a bet on a system that does not exist;
- `schemaVersion 2` breaks any object file written in the last day, with no
  reader for the old shape. That is cheap only because the project ships none.

## Rule

An object's picture is `frames` — never a single `icon` path, never a named
animation list — and the frame arithmetic behind it belongs to
`crates/world/src/animation.rs`, not to whatever is drawing.

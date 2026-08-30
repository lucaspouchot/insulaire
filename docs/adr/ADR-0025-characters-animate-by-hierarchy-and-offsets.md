# ADR-0025 — Characters Animate by a Layer Hierarchy, Offsets and Poses

## Status
Accepted

## Context

A turn-based game whose characters never move is a game of paper dolls, and the
obvious animation model is wrong three times over.

**A frame is not a picture.** An animation that is a list of complete poses fails
at the size this project is already at: the shipped character has seven layers, a
knight in armour will have twenty, and ten animations of twenty layers is two
hundred hand-maintained positions that all move together when the body moves one
pixel.

**Movement is shared.** When a character breathes, the *body* moves and
everything attached comes along. That is a fact about the character, and the
format did not record it — `layers` was a flat list with no statement about what
hangs off what.

**A walking leg is a different drawing.** No offset of a standing leg produces a
walking one, and there is no rotation available: a general transform resamples
the sprite, which is what ADR-0024 exists to refuse. So an animation has to be
able to change *what* is drawn, not only where it is.

The first answer to that was a keyframe naming a `variant` of its node's layer.
It works and it does not scale, because a variant id is a private name for one
implementation while an animation wants to state an *intent*. Legs that already
answer to a build parameter have `thinStand` and `heavyStand`; asking them also
to walk means `thinStride`, `heavyStride`, `thinPass`, `heavyPass`, and a
keyframe that can only name one — forcing the animation to resolve a dimension it
knows nothing about. The same mechanism could not express a **view** at all: a
side-on character is different art for every layer at once, which under keyframe
variants is one `variant` per layer per frame, saying the same thing
twenty-eight times.

Two alternatives were weighed and rejected. **Extending keyframe `variant` to
name a suffix or a pattern** turns variant ids into a naming convention the
engine parses — string surgery as a selection mechanism. **A declared `poses`
vocabulary** on the character is real type safety and a third list to keep in
step with the animations and variants that use it, for a check the validator
performs anyway.

## Decision

**A layer is a node.** `CharacterLayer` gains an optional `parent`, so the layers
form a tree. **The tree is not the draw order**: layers still draw in author
order, and `parent` is an independent reference. A cape is drawn behind the body
*and* hangs off it, and the format keeps those two statements apart.

**An animation is a set of tracks; a track is a set of keyframes.** An
`Animation` has an id, a length in `frames`, a `frameDurationMs`, a `looping`
flag and `tracks[]`. **A node with no track is not still** — it follows its
parent, so making a character breathe is four keyframes on one track.

**A keyframe carries a whole-pixel offset from the rest pose.** The rest pose is
the authored boxes; an animation only says how far from there. Offsets compose
down the tree and a local keyframe *adds* to what was inherited, so a head that
inherits `-2` and writes `+1` ends at `-1`. Rotation and scale are deliberately
absent, because honouring them would resample the art; the shape that leaves
room for them is the transform struct itself.

**An animation sets pose values, and variants choose from them.**

```json
{
  "id": "walking_left", "frames": 4, "frameDurationMs": 130, "looping": true,
  "pose": { "view": "side" },
  "poses": [
    { "frame": 0, "step": "contact" },
    { "frame": 1, "step": "pass" }
  ],
  "tracks": [ … ]
}
```

`pose` holds for the whole animation; `poses` overrides it frame by frame and
holds in both directions, because a drawing does not fade into another one. A
layer answers whichever part of that it has something to say about, through the
`when` it already has — so the body says `view: side` once and answers four
frames, while the legs say it four times because they are four drawings. The file
is as long as the art is, and no longer.

**One namespace.** A `when` key may name a declared parameter or a pose key, and
a variant neither knows nor cares which. That is what makes poses compose with
customisation instead of overriding it. **Poses never join `values`** — they are
reported on `ResolvedPose.values`, because a pose is what a character is *doing*,
and a host that saved one into a save file would have saved a frame of an
animation. **Tints resolve from the customisation alone**: an animation may
redraw a layer, never repaint it.

**An animation may declare `mirrorOf`, and is then its source reflected.** It
borrows the source's frames, duration, looping, tracks and pose; its own are
never read, and a mirror of a mirror is refused. Mirroring is one flag on the
resolved character and the renderer honours it by reflecting the whole canvas
about its vertical centre line. That is the one placement decision the renderer
makes, and it is deliberate: a reflected layout drawn with unreflected pixels is
a character put back wrong, so the pixels must be flipped whatever else happens.

**Evaluation takes a time in milliseconds, not a frame.** Frames are how an
author writes an animation; milliseconds are how anything plays one. The engine
wraps a looping animation and holds a finished one on its last frame. `Step` is
the default interpolation and `Linear` rounds to whole pixels, so it buys
smoother timing and never a fractional position.

**One resolver, animation included.** `resolveCharacter` and `previewCharacter`
take an animation id and a time, and the offset is baked into the resolved box.
The renderer knows nothing about animation: it blits the boxes it is given, so
the editor's preview and the game cannot disagree.

**Everything is optional.** A definition with no `parent`, no `anchors` and no
`animations` resolves exactly as it did before this decision existed.

## Consequences

Positive:
- one animation edit moves the whole character: ten animations over thirty
  layers cost ten lists of what moved, not three hundred positions;
- a walk cycle is authorable, and one authored cycle serves both directions with
  nothing to drift out of step;
- an animation states an intent that composes with what the player chose, so a
  walk cannot draw the wrong legs for a build;
- the preview *is* the runtime, so "it looked right in the editor" means
  something;
- a cycle, a track pointed at nothing, a keyframe past the end, a `when` naming
  neither a parameter nor any pose, and a pose key no variant waits on are all
  caught by the validator before a file is written.

Negative:
- **no rotation and no scale**, so a swinging arm is a sequence of drawn sprites;
  lifting that needs a decision about resampling, not a field;
- a walk cycle is art, not numbers — four leg drawings are four files, and a side
  view is a second set of every layer that differs from the side. That is what
  having no 3D model means; the format simply no longer *multiplies* it by the
  parameters those layers already vary with;
- **the renderer is no longer purely a blitter**: it applies one transform, and a
  host that ignores `mirrored` draws a character facing the wrong way rather than
  failing visibly;
- a mirrored character is mirrored *entirely*, so a scar or a weapon hand swaps
  sides — for an asymmetric figure that is a reason to author the second
  direction properly;
- a pose key is an undeclared string, so the two validation checks above are what
  replaces the type safety a variant id used to have;
- offsets are recomputed per layer on every resolve rather than cached;
- a hierarchy that loops still resolves — the walk stops at the repeat — so a
  broken definition draws something rather than nothing.

## Rule

A character's layers form a tree, and an animation is whole-pixel offsets from
the rest pose plus pose values a variant's `when` selects on. Offsets compose down
the tree and a node's own keyframe adds to what it inherits. An animation that
declares `mirrorOf` is its source reflected. One resolver applies all of it, and
the renderer never learns that time exists.

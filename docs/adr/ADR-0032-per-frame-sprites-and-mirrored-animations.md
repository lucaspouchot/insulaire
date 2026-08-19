# ADR-0032 — A Keyframe May Name a Sprite, and an Animation May Be Another One Mirrored

## Status
**Partly superseded** by `docs/adr/ADR-0033-animations-set-pose-values.md`,
which replaces the keyframe `variant` decided here with pose values a variant's
`when` selects on. The reasoning below about *why* a walk cycle needs different
drawings rather than different offsets still holds and is why ADR-0033 exists;
the mechanism it chose does not. The second half — `mirrorOf`, and the
renderer's single placement decision — is **accepted and unchanged**.

Accepted. Extends `docs/adr/ADR-0031-characters-animate-by-hierarchy-and-offsets.md`,
which stands: layers are a tree, an animation is whole-pixel offsets from the
rest pose, and one resolver applies them. Two of the limitations that ADR
recorded — that an animation could not change *what* a layer draws, and that
there was no way to reuse a cycle in the other direction — are what this one
removes.

## Context

ADR-0031 gave characters movement without giving them drawings. That is enough
for a breathing idle, where nothing changes shape, and it is not enough for the
first animation anybody actually needs after one: a walk.

A walking figure's legs do not translate, they **change**. The knee bends, the
foot leaves the ground, the silhouette is a different silhouette. No offset of
a standing leg produces a walking one, and the project's characters are pixel
art without rotation (ADR-0029), so there is no transform that could.

The second problem arrives with the first. A character that walks left also
walks right, and the right-hand version is not a second animation — it is the
same one seen from the other side. Authoring it twice means every future
correction has to be made twice and stay in step, which is the same
multiplication ADR-0031 exists to prevent, moved from layers to directions.

Two shapes were available for the sprite half. A keyframe could carry a
`sprite { asset, tint? }` of its own, or it could name one of the layer's
existing **variants**. The first invents a second way to say what a layer
draws; the second reuses the vocabulary that already answers that question —
with a box, a tint binding and validation already attached to it.

## Decision

**A keyframe may name a `variant` of its node's layer, and the node draws it
from that frame on.**

`{ "frame": 1, "offset": [0, 0], "variant": "passRight" }` is a walk cycle
changing a leg drawing. Nothing else about the layer moves with it: the box,
the parent, the tint binding and the customisation are all still what the
definition said, so a walk cycle cannot lose a player's chosen hair colour.

**A named variant overrides the `when` conditions** that would otherwise have
chosen one. The animation is being explicit, and an explicit choice is not a
condition to re-test. That is what lets walk sprites live beside conditional
ones on the same layer without inventing a condition nobody chooses.

**A sprite is never interpolated.** It is the one named by the last keyframe
that named one, and it holds until another does — before the first, after the
last, and across every keyframe that only moves. Offsets and sprites are two
tracks of information sharing one list of keyframes, and only one of them is a
continuous quantity.

**An animation may declare `mirrorOf`, and is then that animation reflected.**
`{ "id": "walking_right", "name": "Walking right", "mirrorOf": "walking_left" }`
is the whole entry. It borrows its source's frames, duration, looping, tracks
and sprites; its own are never read, and writing them is a warning. A mirror of
a mirror is refused — one hop, never a chain to walk.

**Mirroring is one flag on the resolved character, and the renderer honours
it.** `ResolvedCharacter.mirrored` asks the host to draw the whole canvas
reflected about the canvas's own vertical centre line.

This is the one placement decision the renderer makes, and it is deliberate.
The alternative — remapping every box in the resolver — does not work: a
reflected layout drawn with unreflected pixels is a character taken apart and
put back wrong, so the pixels have to be flipped whatever else happens. Once
they must be, one canvas transform is both simpler and the only correct answer.
It is still not an *appearance* decision: the resolver said `mirrored`, and the
renderer obeys.

## Consequences

Positive:
- a walk cycle is authorable, which is the animation a game needs after idle;
- one authored cycle serves both directions, and a correction to it corrects
  both — the mirror cannot drift out of step because there is nothing to drift;
- no new vocabulary for "what a layer draws": a keyframe points at a variant,
  and every check, editor field and serialiser rule that already applied to a
  variant applies unchanged;
- the animation still never touches the procedural resolution — swapping a leg
  sprite leaves the tint, the parent and the customisation exactly as they were;
- the format stayed additive again: `variant` and `mirrorOf` are optional with
  `serde` defaults, so `schemaVersion` is still `2`.

Negative:
- **the renderer is no longer purely a blitter.** It applies one transform, and
  a host that ignores `mirrored` draws a character facing the wrong way rather
  than failing visibly;
- a mirrored character is mirrored *entirely* — a hair parting, a scar or a
  weapon hand swaps sides. For a symmetric figure that is invisible; for an
  asymmetric one it is a reason to author the second direction properly;
- an animation still cannot draw a sprite the definition does not declare as a
  variant, so a walk cycle means adding variants to a layer as well as
  keyframes to a track;
- per-frame sprites multiply art the way ADR-0031's offsets avoided
  multiplying positions. That is inherent — a walking leg is a drawing — but it
  means an animation's cost is now real files, not just numbers;
- `frames` had to become optional so a mirror can decline to declare timing it
  does not have, which makes a malformed non-mirror default to one frame rather
  than failing to parse. Validation still refuses a zero-length animation.

## Rule

A keyframe says where a node is and, optionally, which of its layer's variants
it draws; the sprite holds until another keyframe names one. An animation that
declares `mirrorOf` is its source, reflected: same timing, same tracks, same
sprites, one flag, and the renderer flips the canvas as a whole.

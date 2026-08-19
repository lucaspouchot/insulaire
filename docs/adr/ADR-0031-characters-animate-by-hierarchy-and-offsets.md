# ADR-0031 — Characters Animate by a Layer Hierarchy and Whole-Pixel Offsets

## Status
Accepted. Extends `docs/adr/ADR-0028-character-definitions.md` and
`docs/adr/ADR-0029-characters-are-composed-sprites.md`; neither is overturned.
A layer still draws one sprite, placed in whole pixels on a declared canvas, and
a definition plus a customisation still resolves to a flat list of sprites to
blit. What is added is a fourth input to that resolution: *time*.

## Context

ADR-0028 said, in as many words, that animation was deliberately absent: "a
variant names one image, and a character is a still frame today." That is no
longer good enough — a turn-based game whose characters never move is a game of
paper dolls — and the shape of the answer is not obvious, because the obvious
answer is wrong twice over.

**A frame is not a picture.** The cheap thing to build is an animation that is a
list of sprites, or a list of complete poses. Both fail at the size this project
is already at: the shipped character has seven layers, a knight in armour will
have twenty, and ten animations of twenty layers is two hundred hand-maintained
positions that all have to move together when the body moves one pixel. Every
edit becomes twenty edits, and every one of them is a chance to be a pixel out.

**Movement is shared.** What actually happens when a character breathes is that
the *body* moves and everything attached to it comes along. That is a fact about
the character, not about the animation, and it is a fact the format did not
record: `layers` was a flat list, ordered back to front, with no statement about
what hangs off what.

There is also a constraint the obvious animation model would break. ADR-0029
exists because pixel art placed at a fractional position is pixel art with a
seam down the middle. A general transform — rotation, arbitrary scale — resamples
the sprite, and a resampled sprite is exactly what that decision refuses.

## Decision

**A layer is a node.** `CharacterLayer` gains an optional `parent` naming
another layer, so the layers form a tree. Nothing else about a layer changes.

**The tree is not the draw order.** Layers are still drawn in author order,
back to front, and `parent` is an independent reference. A cape is drawn behind
the body *and* hangs off it; those are two different statements and the format
keeps them apart.

**An animation is a set of tracks, and a track is a set of keyframes.** An
`Animation` has an id, a length in `frames`, a `frameDurationMs`, a `looping`
flag and `tracks[]`. A track names one node and holds the frames at which that
node's value changes. **A node with no track is not still** — it follows its
parent. Making a character breathe is four keyframes on one track; the other six
layers move because of the tree.

**A keyframe carries a whole-pixel offset from the rest pose, and nothing
else.** The rest pose is the authored `rect`s, which are still the truth about
where a character's pieces are; an animation only ever says *how far from there*.
Rotation and scale are **not** in this decision, because honouring them would
resample the art (ADR-0029). The shape that leaves room for them is the
transform itself: a node's local value is a struct, so a rotation is a field
appearing there rather than a change to what a keyframe is. In the file the
struct is flattened, so a keyframe reads `{ "frame": 1, "offset": [0, -2] }`.

**Offsets compose down the tree, and a local keyframe adds to what was
inherited.** A node's global offset is the sum of the local offsets along the
chain from it up to its root. That is what makes a correction a *correction*: a
head that inherits `-2` and writes `+1` of its own ends at `-1`, not at `+1`.

**Attachment points are named places, not positions.** A layer may declare
`anchors[]` — a neck, a hair line, a grip — and a child may name one with
`parentAnchor`. They move nothing on their own, and this is deliberate: with
whole-pixel translation the rest pose is already exact, so an anchor that also
displaced its child would be a second, competing way to say where a sprite goes.
What an anchor *is* is the place the joint is, which is where the editor draws
the skeleton, and which is the pivot a rotation will turn about when there is
one. It is the vocabulary put in place before the thing that needs it.

**Evaluation takes a time in milliseconds, not a frame.** Frames are how an
author writes an animation; milliseconds are how anything plays one. The engine
owns the conversion, wraps a looping animation, and holds a finished one on its
last frame. `Step` is the default interpolation and `Linear` is available;
`Linear` still rounds to whole pixels, so it buys smoother *timing* and never a
fractional position.

**One resolver, animation included.** `resolveCharacter` and `previewCharacter`
take an animation id and a time, and the offset is **baked into the `rect`** of
each resolved layer. The renderer is unchanged and knows nothing about
animation: it blits the boxes it is given. The editor's preview and the game
therefore cannot disagree, because there is no second code path to disagree
with. The resolved payload also carries the offset it applied and the pose it
came from, which the *editor* reads to say what the hierarchy did; a renderer
ignores both.

**Everything is optional.** A definition with no `parent`, no `anchors` and no
`animations` resolves exactly as it did before this decision existed.

## Consequences

Positive:
- one animation edit moves the whole character: ten animations over thirty
  layers cost ten lists of what moved, not three hundred positions;
- the preview *is* the runtime — the editor resolves through the same engine
  function a game will call, so "it looked right in the editor" means something;
- the renderer did not change at all, and neither did the paint tools, the
  variant system, the tint pipeline or the customisation resolver;
- a cycle, a track pointed at nothing, a keyframe past the end and an anchor
  that does not exist are all caught by the validator, in the editor, before a
  file is written;
- the format stayed additive: every field is optional with a `serde` default,
  so `schemaVersion` is still `2` and no existing file has to be rewritten.

Negative:
- **no rotation and no scale**, so a swinging arm is a sequence of drawn sprites
  rather than a rotated one. That is the ADR-0029 constraint being honoured, and
  lifting it needs a decision about resampling, not just a field;
- an attachment point does nothing visible yet, which is a piece of vocabulary
  carried ahead of what uses it;
- an animation cannot change *what* a layer draws — swapping a sword sprite
  mid-swing is a variant condition today, and a per-keyframe asset later;
- offsets are recomputed for every layer on every resolve rather than cached.
  With dozens of nodes and a shallow tree that is an ancestor walk per layer,
  and measuring it is what should justify a cache;
- a hierarchy that loops still resolves — the walk stops at the repeat — so a
  broken definition draws something rather than nothing. Validation is what
  reports it, and a host that never validates gets a picture it did not mean.

## Rule

A character's layers form a tree, and an animation is a list of whole-pixel
offsets from the rest pose, per node, per frame. Offsets compose down the tree
and a node's own keyframe adds to what it inherits. One resolver applies them,
and the renderer never learns that time exists.

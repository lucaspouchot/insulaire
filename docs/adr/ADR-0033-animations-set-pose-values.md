# ADR-0033 — An Animation Sets Pose Values, and Variants Choose From Them

## Status
Accepted. Supersedes the first half of
`docs/adr/ADR-0032-per-frame-sprites-and-mirrored-animations.md` — the
keyframe `variant` — and keeps its second half, `mirrorOf`, unchanged.
`docs/adr/ADR-0031-characters-animate-by-hierarchy-and-offsets.md` stands
entirely: layers are a tree, tracks are whole-pixel offsets from the rest pose,
and one resolver composes them.

## Context

ADR-0032 let a keyframe name a variant of its node's layer, so a walk cycle
could swap a leg drawing frame by frame. It works, and it does not scale,
because a variant id is a **private name for one implementation** while the
thing an animation wants to say is an **intent**.

The failure shows the moment a layer varies with anything else. Legs that
already answer to a build parameter have `thinStand` and `heavyStand`; asking
them also to walk means `thinStride`, `heavyStride`, `thinPass`, `heavyPass`,
and a keyframe that can only name one of them. The animation is forced to
resolve a dimension it knows nothing about — and it cannot, because it does not
know what the player chose. Either the author writes one animation per build,
or the walk silently draws the wrong legs.

`when` conditions already answer exactly this question. A variant says what has
to be true for it to be drawn, several conditions at once, and the resolver
picks the first whose conditions all hold. The parameter half of "what has to
be true" was covered; the animation half had no way in.

The second thing ADR-0032 could not express is a **view**. This project has no
3D model, so a character seen from the side is not the front character
translated — it is different art for the body, the cape, the hair, the clothes,
every layer at once. Under keyframe variants that is one `variant` per layer
per frame: seven layers times four frames is twenty-eight lines saying the
same thing twenty-eight times, when the honest statement is "this whole
animation is the side view".

## Decision

**An animation sets pose values, and they join the customisation for as long as
it plays.** Variants select on the result through the `when` they already have.

Two fields, because two questions:

```json
{
  "id": "walking_left", "frames": 4, "frameDurationMs": 130, "looping": true,
  "pose": { "view": "side" },
  "poses": [
    { "frame": 0, "step": "contact" },
    { "frame": 1, "step": "pass" },
    { "frame": 2, "step": "contactBack" },
    { "frame": 3, "step": "passBack" }
  ],
  "tracks": [ … ]
}
```

`pose` holds for the whole animation. `poses` overrides it frame by frame, one
line per frame, and **holds** in both directions — before the first entry it is
the first, after the last it is the last, because a drawing does not fade into
another one.

A layer then answers whichever part of that it has something to say about:

```json
{ "id": "body", "variants": [
  { "id": "side", "when": { "view": "side" }, … },
  { "id": "default", … } ] },
{ "id": "legs", "variants": [
  { "id": "sideContact", "when": { "step": "contact", "view": "side" }, … },
  { "id": "sidePass",    "when": { "step": "pass",    "view": "side" }, … },
  … ,
  { "id": "stand", … } ] }
```

The body says `view: side` **once** and answers all four frames. The legs say
it four times because they are four drawings. That ratio is the whole point:
the file is as long as the art is, and no longer.

Three consequences follow, and each is deliberate.

**One namespace.** A `when` key may name a declared parameter or a pose key,
and a variant does not know or care which. `{ "armor": "plate", "view": "side" }`
is one condition, half of it chosen by the player and half by the animation.
That is what makes poses compose with customisation instead of overriding it —
the defect ADR-0032 had no answer to.

**Poses never join `values`.** The resolved character's `values` stay the
customisation, and the pose is reported separately on `ResolvedPose.values`.
A pose is what the character is *doing*, not what was chosen about it, and a
host that saved one into a save file would have saved a frame of an animation.

**Tints are resolved from the customisation alone.** An animation cannot
repaint a layer, only redraw it. Hair tinted from `hairColor` keeps that colour
through every frame of every animation, which is the rule ADR-0031 set and this
does not touch.

`Keyframe.variant` is **removed**. Pre-1.0, a second way to choose a drawing is
worse than a breaking change (`CLAUDE.md`, "Versioning"), and everything it
could express a pose expresses better.

## Consequences

An animation is now two statements rather than one: what the character is drawn
as, and how far its nodes moved from there. The editor shows them as two
things — a pose row above every node in the timeline, and a pose editor beside
the transform panel — because they are edited at different moments and by
different reasoning.

Validation gained both directions of the new coupling. A `when` naming neither
a parameter nor a pose any animation sets is an error
(`character.unknownConditionParameter`, now with a wider message); a pose key
no variant waits on is a warning (`character.unreadPoseKey`), because it is
invisible otherwise — the animation plays, and nothing happens. Those two
checks are what replaces the type safety a variant id used to have.

A pose key is an undeclared string. There is no list of legal pose keys and no
schema for their values, deliberately: declaring them would be a second
parameter list that no runtime reads, and the two validation checks above catch
the typo that the declaration would have caught. The editor offers the keys and
values the character's own `when` conditions already use, so the common path is
picking from a list rather than typing.

`mirrorOf` is unchanged and now reflects the pose too, since the pose belongs
to the source animation like everything else. A mirror that sets a pose of its
own is a warning (`character.mirrorWithPose`).

The cost is that a walk cycle is art, not numbers. Four leg drawings are four
files, and the side view of a character is a second set of every layer that
looks different from the side. Nothing here avoids that — it is what having no
3D model means — but the format no longer *multiplies* it by the parameters
those layers already vary with.

## Alternatives considered

**Keyframe `variant`, kept and extended** — let a keyframe name a *suffix* or a
pattern rather than an id. This keeps a per-node channel that has to be
repeated for every layer that reacts, and turns variant ids into a naming
convention the engine parses. String surgery as a selection mechanism is worse
than the conditions already in the format.

**Pose values per node, inherited down the layer tree** like offsets are. It
composes elegantly and buys nothing: a pose read by one subtree is a pose with
a key nobody else waits on, which the flat namespace already expresses, and it
would have made the legs' independence from the torso an accident of parentage.

**A declared `poses` vocabulary on the character**, listing legal keys and
values like `parameters` does. It is real type safety and it is a second list
to keep in step with the animations and the variants that use it — three places
where there are now two, for a check the validator performs anyway.

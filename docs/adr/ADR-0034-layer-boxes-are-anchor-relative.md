# ADR-0034 — A Layer's Box Is Measured From the Joint It Hangs Off, and a Variant May Step Out of the Draw Order

## Status
Accepted. Completes `docs/adr/ADR-0031-characters-animate-by-hierarchy-and-offsets.md`,
which made layers a tree that *animation* composed down; this makes the same
tree compose **position**. `docs/adr/ADR-0029-characters-are-composed-sprites.md`
stands unchanged — everything is still whole pixels on a declared canvas, and
there is still no rotation or scale. `CHARACTER_SCHEMA_VERSION` goes to `3`.

## Context

ADR-0031 introduced `parent` and `parentAnchor`, and then used almost none of
it. `parent` composed animation offsets; `parentAnchor` named a joint that the
resolver never read. Every box was absolute on the canvas, so the hierarchy was
a statement about *movement* and nothing else.

That left three problems, and they are the same problem three times.

An **attachment point meant nothing**. A file could say the head hangs off the
neck and put the head anywhere; the two statements could not disagree, because
only one of them was read.

**Moving a body meant moving everything by hand.** Nudging the torso down two
pixels in the rest pose meant editing the head, the hair, the arms and the
armour by two pixels each — exactly the multiplication the tree was introduced
to avoid, avoided for animation and not for authoring.

**The numbers said nothing.** `"rect": [23, 36, 18, 14]` for a chest piece is
four coordinates on a canvas. Whether it is correctly registered against the
shoulders is not visible in it, and a sprite drawn to sit exactly on its joint
has no distinguished value — it is `[23, 36]` like anything else.

Separately, the draw order was **fixed at the layer**. Layers draw back to
front in declaration order, which is right nearly always and wrong exactly when
the character turns: a cape hangs behind a body seen from the front and drapes
over the near shoulder — in front — seen from the side. There was no way to say
so.

## Decision

**A layer's box is measured from the point it hangs off.**

```
origin(root)  = the canvas origin
origin(child) = origin(parent) + the anchor it names on that parent
rect(layer)   = origin(layer) + the box in the file
anchor.at     = measured from its own layer's origin
```

Local transforms from an animation compose into `origin` at each step, so a
node's frame carries both where it is and how far it has been moved. A child
naming no anchor measures from its parent's own origin; a root hangs off
nothing, so its box is a canvas position exactly as before.

A sprite drawn so that its own top-left corner sits on the joint is therefore
`[0, 0, width, height]`, and the numbers in a file become a **distance from a
neck** rather than a position on a canvas. `ResolvedLayer` carries the absolute
box as it always did, plus the `origin` it was measured from, so no renderer
changes and an editor can turn a click back into the number an author typed.

**And a variant may name an `order`.**

```json
{ "id": "sideWorn", "when": { "cape": true, "view": "side" },
  "rect": [1, -6, 14, 76], "order": 1, "sprite": { … } }
```

Layers sort by `order` first and by declaration second, stably, so `0` is the
author order and everything sharing an order keeps the file's sequence.

It lives on the **variant**, not on the layer and not on the animation, because
that is where a condition already lives. The cape above is the same `when` that
chose its side-on drawing, with one more field — and it composes with a
customisation for free, so armour worn over a cloak is the same mechanism. An
`order` on the animation would be a second vocabulary saying the same thing,
and one that a customisation could not participate in
(`docs/adr/ADR-0033-animations-set-pose-values.md`).

## Consequences

Every character file changes meaning, so `CHARACTER_SCHEMA_VERSION` goes to `3`
and `content/characters/human_player.json` is rewritten. Pre-1.0 there is no
reader for version 2 and none is coming (`CLAUDE.md`, "Versioning"). The rewrite
is pixel-neutral by construction — each child's box is its old absolute
position minus its joint — and the smoke baseline is the proof.

The editor gains a real obligation: the numbers on screen are no longer where
the sprite is. Painting, picking and the selection box read the **resolved**
box; the skeleton draws its bones from each layer's `origin`; and changing a
layer's parent or anchor **rebases its boxes and its own anchors** so the
character does not jump — deciding what a layer follows is a separate act from
moving it. The variants panel says which joint the numbers are measured from and
where that joint landed, because otherwise `[-9, 0]` is unreadable.

Validation moves with it: whether a box fits the canvas is now a question about
where it *lands*, so `character.rectOutOfCanvas` is computed after placement.
Negative coordinates are ordinary — a fringe sits above and left of a hairline —
and no longer suggest anything is wrong.

What this does not do is make the tree the draw order. They stay independent,
and `order` is the exception that proves it: a cape hangs off the body and is
drawn behind it, until a condition says otherwise.

## Alternatives considered

**Keep boxes absolute and give the editor a "move with children" tool.** It
solves the authoring nuisance and none of the modelling: the file still cannot
say where a head belongs, `parentAnchor` still means nothing, and the tool is a
second place that knows the hierarchy.

**Make a layer's origin its own box's corner**, with anchors measured from
there. It reads well for an artist — "the neck is 11px from the left of the body
sprite" — and it breaks on variants: a layer whose drawings have different boxes
would move its joints when the customisation changed one. The frame has to be a
point the variants share.

**`order` on the layer, or a reordering list on the animation.** The first
cannot vary with anything, which is the whole requirement. The second works and
duplicates `when`: it would let an animation reorder layers and leave a
customisation unable to, for a case — armour over a cloak — that is the same
case.

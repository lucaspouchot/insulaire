# ADR-0024 — Characters Are Definitions Plus Customisations, Resolved in Rust

## Status
Accepted

## Context

The game needs a player character with choices — gender, hair colour, height —
and it will need merchants, goblins, skeletons and a dragon. Every one has to be
drawn, and most have something that varies between two of the same kind.

Writing the thing actually asked for, `PlayerCharacter { gender, hair_colour,
height }`, is a dead end: `gender` means nothing to a skeleton and `horns`
nothing to a merchant. A type per category multiplies the renderer by the
bestiary, and the day a goblin needs a hair colour there are two implementations
of hair colour. It also puts a gameplay word in the renderer, which `CLAUDE.md`
forbids. **A scripting hook per character** handles everything, is a non-goal,
is unreviewable as content and is undrawable in a preview.

The first version of this decision drew characters from shape primitives on a
unit square — floats in `0..1` — with a `procedural` and an `assetComposition`
mode. That was wrong twice for the pixel art this project actually wants.
Unit-square geometry cannot place a sprite: `0.38 × 64 = 24.32` is a third of a
pixel of drift, which is a seam between two layers drawn to touch, and a
different seam at every zoom. And one-colour primitives were never a rendering
mode — they were a blockout tool promoted to an architecture, costing two
vocabularies, two validators and a field whose only job was to stop an author
mixing them.

A second correction followed from the layer tree. Boxes were absolute on the
canvas, so `parentAnchor` named a joint the resolver never read: a file could say
the head hangs off the neck and put the head anywhere. Nudging a torso two pixels
meant editing the head, the hair, the arms and the armour by two pixels each —
the multiplication the tree exists to prevent, avoided for animation and not for
authoring.

## Decision

**A character is a `CharacterDefinition` plus a customisation, resolved into a
`ResolvedCharacter`.**

```text
CharacterDefinition + values ──> resolve() ──> ResolvedCharacter ──> renderer
```

One pipeline for every category. There is no player branch in it, and the
renderer never reads `category` — a category is how an author files a
definition, not how it is drawn.

**A definition is two lists.** `parameters` are the choices it offers; `layers`
are the pieces it is drawn from, back to front. A layer holds `variants`, and a
variant declares the parameter values it answers to (`when`), where it is drawn
(`rect`), and the sprite it draws. Nothing in the model knows what a body, a head
or a wing is.

**A parameter is a `ControlDefinition`** — the settings vocabulary of ADR-0022,
reused whole and resolved by the same `resolve_controls`, so an unknown option or
an out-of-range number means the same thing for a character as for a setting.
`scope` is the one field that does not carry over.

**The first matching variant wins.** Author order is priority, which makes "most
specific first" visible in the file. A layer with no match draws nothing, which
is how an optional piece is authored.

**A layer draws a sprite, and that is all it can draw.** A variant carries
`sprite { asset, tint? }`. A definition declares its canvas — `resolution
{ width, height }`, at most 256 a side — and every layer box is a position on
that grid, in whole pixels. `x` and `y` may be negative so a cape can overhang.
The canvas *is* the character's size: a rat is authored at 32×32 and a dragon at
256×256, and a host draws each at its native size times a whole-number zoom. The
map host is the one exception, and it is ADR-0031's.

**A tint recolours a sprite**, fixed or read off a parameter: the multiply is
per-pixel over the RGB with the alpha carried through untouched, so a near-white
sprite becomes the tint with its own shading intact and *one* greyscale hair
sprite serves every hair colour. A missing sprite draws as a dashed outline,
which is the blockout tool the primitives were pretending to be.

**A layer's box is measured from the point it hangs off.**

```text
origin(root)  = the canvas origin
origin(child) = origin(parent) + the anchor it names on that parent
rect(layer)   = origin(layer) + the box in the file
anchor.at     = measured from its own layer's origin
```

A sprite drawn so its top-left corner sits on the joint is `[0, 0, w, h]`, and
the numbers in a file become a distance from a neck rather than a position on a
canvas. `ResolvedLayer` carries the absolute box plus the `origin` it was
measured from, so no renderer changes and an editor can turn a click back into
the number an author typed.

**A variant may name an `order`.** Layers sort by `order` first and declaration
second, stably, so `0` is author order. It lives on the variant because that is
where a condition already lives: the same `when` that chose a cape's side-on
drawing puts it in front of the shoulder, and a customisation participates for
free. The tree is still not the draw order; `order` is the exception that proves
it.

**Colours and geometry resolve in Rust.** The boundary carries two resolvers:
`resolveCharacter(id, values)` for registered content, and
`previewCharacter(json, values)` for a definition the editor is still writing.
Resolution is total, so an unfinished definition previews as whatever it is.

**Characters are content the manifest lists**, validated as loaded before a
project loads.

## Consequences

Positive:
- a goblin, a merchant and the player are the same structures, validator,
  resolver and editor — a new creature is a JSON file;
- the preview cannot flatter the result: it is the shipping pipeline;
- the format says what pixel art is, and "the hair moved up two pixels" reads as
  `"rect": [23, 8, …]` rather than as a float;
- tinting turns "hair colour" into one sprite instead of twelve;
- sizes compose honestly: a 32×32 goblin next to a 128×128 knight needs no
  per-character scale;
- moving a torso moves what hangs off it, and a file can finally say where a
  head belongs;
- validation catches a condition on an undeclared parameter, a colour bound to a
  number, a sprite with no path and a box that lands off the canvas.

Negative:
- more machinery than "the player has three sliders" needs;
- one variant per combination is the rule for anything but a tint, so three hair
  styles and two genders that interact need six variants;
- nothing scales within a definition, so "tall" and "short" are two sets of
  sprites;
- the canvas is capped at 256, and lifting it is a code change and an ADR;
- an authored `rect` that disagrees with its image's real size stretches the
  sprite, and only the editor's *fit to image* defends against it — the engine
  never sees an image;
- `ControlDefinition` carries `scope`, which characters ignore;
- the editor owes a real obligation: the numbers on screen are not where the
  sprite is, so painting, picking and the selection box read the *resolved* box,
  and changing a parent or an anchor rebases the layer's boxes so nothing jumps.

## Rule

Character appearance is authored as a `CharacterDefinition` and resolved by
`insulaire_world::character`. No host resolves a character itself, and no
category — player, NPC, monster — gets a type, a pipeline or an editor of its
own. A layer draws one image, placed in whole pixels on the canvas its definition
declares and measured from the joint it hangs off.

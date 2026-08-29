# ADR-0048 — A Decoration Is Anchored to a Hex, in Two Planes

## Status
Accepted, and **amended by
`docs/adr/ADR-0051-a-decoration-is-placed-and-the-placement-decides.md`**:
`interactive` moved off the definition onto the placement, and the placement —
the field this ADR deliberately did not add — now exists. Everything else below
stands. Turns `docs/adr/ADR-0039-one-editor-for-everything-drawn.md`'s
*planned* `decorations` category into an available one and gives it a content
format; `docs/adr/ADR-0049-an-object-is-carried-not-placed.md` does the same for
its sibling row. No existing schema changes shape: `WorldDefinition` and
`TileSetDefinition` are untouched, and the manifest gains one optional list.

## Context

**A tile says what the ground *is*. Nothing said what is *on* it.**

The format has hexagons (ADR-0035), characters standing on them (ADR-0029) and
doors between maps (ADR-0017), and no way to author a tree. Every world that
needs one today has to paint it into the terrain, which makes it part of the
ground: it cannot be interacted with, it cannot animate, it cannot be moved a
pixel, and two of them cannot share a cell.

Four things have to be true of a thing standing on a hex, and none of them is
true of a tile.

**It is placed at a pixel, not at a cell.** A tree is not centred on its hex —
its *trunk* is. A hanging lantern is not centred either; the ring it hangs from
is where the ceiling is. Centring the image and nudging it back with a
per-placement offset was tried on paper and rejected: *as a replacement for the
anchor* the nudge is a property of the drawing, not of the placement, so every
author who placed the same tree would rediscover the same two numbers. ADR-0051
later added an offset **on top of** the anchor, which is the other thing: the
tree's own arithmetic stays in the definition, and the placement varies it.

**Depth on one cell is not a single number.** A character standing on a hex is
*in front of* the grass under their feet and *behind* the canopy of the tree
they are under. A single z-index cannot say that. It can only say it if the
renderer knows which values mean "past the characters" — a magic threshold, and
exactly the scenario-shaped knowledge `CLAUDE.md` forbids the engine to carry.

**It animates, but not the way a character does.** A character is a tree of
layers moved by per-node offsets with poses and mirrors (ADR-0031, ADR-0032,
ADR-0033). A torch is four drawings. Reusing `CharacterDefinition` for a torch
would mean a skeleton, an anchor list, a variant list and a track list to say
"play these four PNGs", and every one of those fields would be empty in every
decoration file in the project.

**A placed one has to be nameable.** The player opens *this* chest and searches
*that* bush, and the scenario has to say which. That is a property of the
placement, not of the kind: a map may hold twelve chests from one definition.

Three shapes were rejected.

**A decoration is a tile flag.** Cheapest, and wrong in every direction: a tile
is a palette entry shared by hundreds of cells, so a chest that opens would open
everywhere, and a cell could hold exactly one.

**A decoration is an entity.** `EntityDefinition` already places something at a
cell with a unique id and a property bag. But an entity is a *simulated* thing —
it has a template, a behaviour, and it blocks movement — and a shrub is none of
those. Making every bush an entity puts every bush in the simulation's loop.

**A decoration is a character with no animation.** The two are both "a picture
placed somewhere", and stopping there is how a format grows a field that means
one thing for one caller and nothing for the other. A character is customised by
parameters, tinted, composed from layers and hung on a skeleton; a decoration is
none of that and needs an anchor, a plane and an order, which a character has no
use for.

## Decision

**A `DecorationDefinition` is its own content file, and it carries three numbers
a tile and a character do not.**

```json
{
  "id": "torch", "schemaVersion": 1,
  "resolution": { "width": 16, "height": 32 },
  "anchor": [8, 31],
  "plane": "front",
  "order": 2,
  "animations": [
    { "id": "burning", "frameDurationMs": 100, "looping": true,
      "frames": ["assets/decorations/torch_0.png", "assets/decorations/torch_1.png"] }
  ]
}
```

**Anchored, not centred.** `anchor` is the pixel of the decoration's own canvas
that lands on the cell's **ground point**. A tree anchors at the foot of its
trunk, a puddle at its middle, a lantern at its ring. The resolver returns
`placement` — `[x, y, width, height]` relative to that ground point, anchor
already subtracted — so the editor's preview and the map renderer cannot
disagree about where a trunk is.

**The anchor is a position on the cell, and the cell is what it is judged
against.** An anchor outside the decoration's *own canvas* means nothing is
wrong: it is a small prop dropped away from the middle of its hex, which is an
ordinary thing to author. Reporting it — as this ADR first did — was noise on
exactly the case the anchor exists to allow. What is worth reporting is the
**drawing leaving the hexagon**, `decoration.overflowsCell`, and that stays a
**warning** in both directions: a big tree is *supposed* to overhang its cell,
and an author who did not mean to should hear about it.

Measuring it needs the cell's pixel grid, which a decoration file does not
carry, so `validate_decoration` takes an optional `TileArtGeometry` — the same
shape `validate_world` takes an optional tile set. Without one, every other
check still runs and this one is skipped: loading a definition needs no tile
set, and the editor, which knows which set it is authoring against, gets the
warning.

The whole box counts, height included, so a tree tall enough to stand above its
hex is reported — which is the case the warning is *for*. That only stays signal
because a new decoration starts as **exactly its hex**: the project's tile box
for a canvas, anchored at the middle of it. Starting it at the foot instead made
every new decoration overflow on creation, which is the same noise this
amendment removed, one field further along.

**Two planes, then an order.** `plane` is `behind` or `front`; `order` sorts
within it. The draw order on one cell is: everything `behind`, then the
characters, then everything `front`. This is the decision, and it is two fields
rather than one because the thing that has to be expressible — "a character
passes between these two decorations" — is not expressible as a single number
without the renderer learning a threshold.

**An appearance is a flipbook, and a state is an appearance.** A
`DecorationAnimation` is a named ordered list of image paths plus a frame
duration and a loop flag. One image per frame. A chest declares `closed` and
`open`, each one frame long, and the scenario asks for one by id — so *states*
cost no new concept. A looping appearance wraps; one that does not holds its
last frame, which is what makes a one-shot state stay in the state it reached.

**Whether, never what.** A decoration may be interacted with; it never says what
happens — opening a chest and searching a bush are scenario content (ADR-0005),
and an `if this is a chest` in the engine is the thing `CLAUDE.md` exists to
prevent. *Where* the "whether" lives was this ADR's mistake: it put the bit on
the definition, and ADR-0051 moved it to the placement, because a map holds a
dozen chests from one definition and only one of them holds the letter.

**A placed decoration carries its own id.** A map's placement — added by
ADR-0051 — names the definition, a cell, and an id unique within the map, which
is what the scenario addresses. That id belongs to the placement
because one definition is placed many times, and only the placement is a thing a
player can open.

**The engine resolves it, as it resolves a character.** `resolveDecoration` and
`previewDecoration` cross the boundary beside `resolveCharacter` and
`previewCharacter`, for the same reason ADR-0028 gave: the editor's preview and
the runtime draw what the *same* Rust code produced, so a preview cannot
flatter the result. Frame arithmetic and anchor subtraction happen once, in
`crates/world/src/decoration.rs`.

**The editor's scene is the hexagon, not a checkerboard.** `/editor/asset/decorations`
draws the decoration on a hexagon at the project's own tile geometry
(ADR-0035), with a figure standing on the same ground point. The
anchor is set by **dragging the image** until its trunk sits on the cross, and
the plane switch visibly moves the tree in front of the walker or behind them.
Typing `[8, 31]` and hoping is what this replaces. The pixels are painted on the
shared surface every other category paints on (ADR-0039).

**The figure is a real character.** The player, an NPC, a monster — whichever
the picker names, resolved by the engine's own resolver and drawn by the
renderer the game draws with, at the scale the map places one
(ADR-0028, ADR-0044). The question the plane answers is "does a character pass
in front of this", and a stand-in shape answers it only approximately: a rat and
a dragon disagree about whether a fence hides them. A plain silhouette remains
the fallback for a project that ships no character definition at all, because
something has to stand there or the switch shows nothing.

**The cell is what the fit guarantees.** The zoom holds the hexagon and the
decoration's own box, and deliberately *not* the figure: a figure two tile faces
tall drove the ground point down far enough to push the hex off the bottom of
the frame at a large interface scale, and the hex is the one thing an author is
always lining something up against. A guide may be clipped; the cell may not.

**The `decorations` row stops guessing what it is.** ADR-0039 declared five
categories with placeholder summaries, and the two it guessed at were the wrong
way round: it described *decorations* as what dresses a tile and *objects* as
what stands on a map. It is the opposite. Both summaries are rewritten.

## Consequences

Positive:

- a tree, a house and a chest are authorable content, and several share a cell;
- an author *sees* the plane decision instead of reasoning about it, and places
  the anchor by dragging rather than by arithmetic;
- animation costs one list of paths, so a torch is a file a person can read;
- a state and an animation are one concept, so the scenario has somewhere to
  point before the scenario runtime exists;
- the engine still contains no interaction rule: `interactive` is a bit.

Negative:

- **the placement was not implemented here.** This change defined the kind, not
  the instance; ADR-0051 added the map's `decorations` list, the editor tool and
  the renderer's two passes;
- **a fourth content kind to keep in step.** Rust type, TypeScript mirror,
  serialiser, validator, boundary method, library service and editor — seven
  places, and the format is only worth it because a decoration genuinely differs
  from a character in all three of its placement fields;
- **two ways to animate.** A character animates by skeleton, a decoration by
  flipbook, and an author has to know which they are editing. The alternative
  was one format that is mostly empty in both;
- **`order` is a bounded integer, so it can collide.** Two decorations at the
  same order in the same plane sort equally; ADR-0051 settled the tie with
  author order;
- **the figure can be clipped.** Keeping the hexagon whole means a tall
  character's head leaves the top of a short frame; the alternative was losing
  sight of the cell, which is worse;
- the overflow warning needs a cell, so it is absent exactly where a definition
  is loaded rather than authored — a decoration that overhangs is reported in
  the editor and silent in the runtime's report.

## Rule

A decoration is anchored at a pixel and sorted in one of two planes, never one
combined z-index. It says *whether* it can be interacted with; what happens is
the scenario's, and no rule about a decoration lives in the engine.

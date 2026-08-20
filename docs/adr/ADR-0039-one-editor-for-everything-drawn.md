# ADR-0039 — One Editor for Everything the Game Is Drawn From

## Status
Accepted. Folds the `character` module into `asset` in
`docs/adr/ADR-0019-editor-modules.md`'s registry, gives the category browser
`docs/adr/ADR-0035-tile-art-is-authored-and-resolved-by-level.md` sketched its
first real second entry, and moves the painting surface
`docs/adr/ADR-0030-the-editor-paints-its-sprites.md` decided into it. No schema,
no engine boundary and no content file changes shape: this is where authoring
happens, not what is authored.

## Context

**Two editors were painting pixels, and neither knew the other existed.**

`/editor/character` composes a figure and paints it — pencil, eraser,
eyedropper, a palette ranked by use, undo — written into
`character-editor-page.ts`, a 2594-line component that also holds the layer
tree, the variant forms, the parameter list and the animation stage
(ADR-0029, ADR-0030).

`/editor/asset` browses a tile set and paints it — pencil, eraser, **fill**,
eyedropper, a **movable rectangular selection**, an **alpha** — in
`tile-pixel-editor.ts`, a 546-line component (ADR-0035).

Both edit a `SpriteDocument`: the same framework-free RGBA buffer, the same
bounded undo, the same palette arithmetic. They differ in tools not because a
tile needs different tools than a cape does, but because the second was written
eighteen months of decisions after the first, with the first sitting right
there. An author who has learned to fill a shoreline cannot fill a boot.

**The asset browser has advertised a Personnages row with nothing behind it.**
ADR-0035 declared the categories rather than hiding them, on the shell's own
precedent — the browser is the map of what the tool will hold. Four of the five
rows name something that does not exist yet. The fifth names something that
exists on another screen. Read literally, that row promises a *second* place to
author a character, which was never the intent and is not a thing anyone wants.

**The tile screen's centre column is already too small, and a figure would not
fit in it at all.** The stage stacks a preview bar, the preview canvas and the
whole pixel editor in one column: `.preview-canvas` is `flex: 1` with
`overflow: hidden`, and `fitPreview()` refuses to shrink a hexagon below two
pixels a side. So the preview does not scale down when the column is short — it
is **clipped**, silently, and the taller the toolbar below it grows the more of
the hexagon goes missing. A tile survives this because there is not much to look
at. A character is a tall narrow figure that must be judged whole, at the zoom
the game draws it, next to a layer tree, a variant form and an animation
timeline. The same column would clip all of it.

Three answers were rejected.

**Delete the Personnages row.** Honest, cheap, and where this investigation
started: nothing documented it, and the character module already did the job. It
also leaves the real cost untouched — two paint stacks, two palettes, two undo
histories, two answers to "how do I draw a pixel here", and every future tool
owing a decision about which of them to land in.

**Share the pixel editor, keep two modules.** Removes the duplicated code and
none of the confusion. An author still has to know that a tile is drawn on one
screen and a character on another, when both are, in the only vocabulary that
matters to them, *the pictures the game is made of*.

**One page for everything.** Merging two components that are 946 and 2594 lines
produces the screen nobody dares to change — precisely what ADR-0019 exists to
prevent. The unit that should be shared is the *frame* and the *tools*, not the
document logic: a tile set and a character library are genuinely different
documents, with different files, different validators and different lists.

## Decision

**`/editor/asset` is the only place pixels are authored, and a category is a
route under it.**

```text
/editor/asset/tiles       TileWorkspace       available   (ADR-0035)
/editor/asset/characters  CharacterWorkspace  available   (ADR-0028…ADR-0034)
/editor/asset/objects     planned
/editor/asset/decorations planned
/editor/asset/effects     planned
```

`character` leaves `EDITOR_MODULES`. The project is pre-1.0, so `/editor/character`
is **gone**, not redirected (`CLAUDE.md`). `ASSET_CATEGORIES` becomes what
`EDITOR_MODULES` is one level up: the single list the child routes, the rail and
the planned-category page all read, so a future category is one entry now and
one component later.

**A category owns its document; the module owns the frame.** `AssetEditorPage`
holds the category rail and a `router-outlet`, and knows nothing about tiles or
characters. Each workspace keeps its own file, its own toolbar, its own
validation and its own list — the two documents were never the duplication.

**One frame, and the height belongs to the scene.** `AssetWorkspace` draws the
rail, projects the open category's four parts, and gets out of the way:

```text
┌───────────┬──────────────────────────┬──────────────┐
│ Tiles     │ toolbar — file, save     │              │
│ Characters├──────────────────────────┼──────────────┤
│ Objects   │ ┌──┐                     ║              │
├───────────┤ │to│       scene         ║  inspector   │
│ <search>  │ │ol│                     ║              │
│ Grass     │ │s │                     ║              │
│ Dirt      │ └──┘                     ║              │
└───────────┴──────────────────────────┴──────────────┘
```

**The rail and the list are one column.** A category name and a character name
are both three words wide; two columns to hold them cost the scene 240 pixels
it had a use for.

**Nothing runs along the bottom.** A dock was tried and taken out again: it took
two hundred pixels of height off every screen for something one category had a
use for, and what it cost was exactly what a character editor cannot spare — a
figure is 128 pixels tall, and at a zoom worth drawing at, on a screen at 140%
interface scale, the dock was the difference between seeing it whole and not.
The timeline went back to being an inspector tab and the hexagon shares the
scene with the pixels.

**There is no paint mode.** Every surface always paints. ADR-0030 made it a
mode because turning it on decodes every sprite the character draws; that is a
few dozen small PNGs, and the click cost more than the decode. What the mode was
also deciding, on the character stage, is what a *drag* does — paint, or move
the open node to author a pose — and that is decided by **the open inspector
panel** now: the animation editor in front of you means you are placing a limb,
anything else means you are drawing. The hint under the stage says which.

One thing follows that is worth knowing: the open layer is drawn **without its
tint** at all times, not only while painting, because painting is now all the
time — ADR-0030's rule unchanged, applied continuously. A tinted layer says so
on screen.

**A control is shaped like the choice it makes.** Two surfaces is one switch,
not two buttons; the skeleton overlay is a checkbox beside the grid's, because
that is what it is.

**Zoom, fit and the grid live in the file bar.** Above every surface, in the one
row a category always shows, rather than on whichever toolbar happens to be up:
the composed stage, the flat image and the hexagon all step through the same
ladder of whole zooms, and the flat editor takes its zoom and its grid as a
`model` from the workspace instead of keeping its own. The grid is a **view**
setting, not a paint one — an author lining a cape up with a shoulder wants it
without picking up a pencil.

**A fitted surface does not scroll.** `overflow: hidden` unless a zoom was
asked for, because a canvas sized from its frame's client box plus a scrollbar
is a loop: the scrollbar shrinks the box, the box shrinks the canvas, the canvas
loses the scrollbar, the box grows. Run by a `ResizeObserver` at frame rate,
that reads as a figure shivering in place. Nothing overflows a fit, so nothing
needs to scroll.

**The divider is how the proportions get fixed.** A timeline wants a wide
inspector; a figure wants a wide scene; the author is the one who knows which
they are doing this minute. The inspector's width is dragged, and `min-width: 0`
is what makes that possible in both directions — a flex item's minimum is its
content by default, so one wide timeline silently pushed the column past the
width it had been dragged to and the divider could not pull it back.

Inside it, the animation editor is **one column**: splitting it put the timeline,
the thing an author reads and clicks constantly, in the narrowest part of the
narrowest column. It gets the full width, and the transport and the grid stay
**pinned** while the rest scrolls — with a switch, because a tall timeline
pinned to the top of a short column is worse than one that scrolls away.

**The tools are a row over the surface, wherever the surface is.** A vertical
strip down the side was tried — it costs no height, which is what a composed
character is short of — and it reads as a different tool from the row the flat
view wears. One bar, one place, and the height is bought back by keeping it to
one line: three tools, a colour, an opacity, undo, zoom.

**One pixel surface, one toolbar, one palette — and three tools.** `pixel-editor`
— the tile editor's component, renamed because it was never about tiles — is the
flat surface every category paints on, and `pixel-tools` is the toolbar, a
presentational component that holds no buffer and is therefore worn by the
composed character stage as well.

Sharing the toolbar forced the question of which toolbar was right, and the
answer was the smaller one. **The fill and the movable rectangular selection are
removed** — from the buttons, from `sprite-document.ts`, and from the tests. A
pencil, an eraser and an eyedropper are what retouching in place needs; a fill
and a selection are the beginning of a drawing application this project decided
in ADR-0030 not to build, and having built two of them for tiles did not make
that decision wrong. The **alpha stays**: it is a property of a pixel, not a
tool, and it costs one slider.

What a category still supplies is the *guides* drawn behind the pixels — a
tile's hexagon geometry, or none at all — so the surface never learns what it is
drawing.

**The character scene has two modes, over one buffer.** *Composed* draws the
figure and paints the open layer in place — ADR-0030's whole point, the last
three pixels judged against the rest of the figure. *Flat* draws that layer's
sprite alone, at the zoom the pixels want, for the work the figure around them
gets in the way of. They are two views of the same `SpriteDocument`, so a stroke
in one is already in the other and there is nothing to synchronise.

**Fitting means the frame, both ways.** A stage that fitted the width and took a
fixed 400 pixels of height left the figure small under a band of nothing, and
the box the click arithmetic used was not the box on screen. At an explicit
zoom the canvas is centred in its frame with `safe` centring, so a figure larger
than the frame can still be scrolled to its own top-left corner.

**A tile is painted on its hexagon.** The preview *is* the drawing surface, as
the composed figure is for a character (ADR-0030) — there is no second flat copy
of the image beside it, because two surfaces showing the same pixels means
neither is large enough and the author has to decide which to look at. Three
things make it work: the painted cell draws **the variant being edited** rather
than the one the map's hash rolls (`CellArt` says which, the same override a
cell of a map uses); `previewImageBox()` is asked where an image landed, by the
draw *and* by the hit test, so a click cannot drift from a blit; and a pointer
goes through `previewPointOf()` first, because the draw is translated into the
hex plane and a box and a click are otherwise in two different frames.

*Several tiles* still shows the tile among its neighbours, and the middle one is
still the one that paints — which is the point: the seam you are fixing is
visible while you fix it.

**A preview scales or it scrolls; it never crops.** `fitPreview()` loses its
floor of two, and a canvas sized in script from its parent's box is repainted by
a `ResizeObserver` on that box rather than only when the window changes —
otherwise a divider dragged narrower leaves a canvas at its old size, drawn
straight over the inspector. Clipping was never a layout decision; it was the
absence of one.

**Alpha is allowed on a character.** ADR-0030 forbade it because a soft edge
survived the tint as a fringe no recolouring could fix. That was a statement
about the tint pipeline, and the tint pipeline is fixed by this change rather
than legislated around: see the amendment recorded in ADR-0030 itself.

## Consequences

Positive:

- there is one answer to "where do I draw", and it is the same answer for a
  tile, a cape and, later, a torch;
- the tools stop diverging by accident: one component, one toolbar, one palette
  model, one undo, and the next tool lands once;
- a character is editable at full height: at 140% interface scale on a 900-pixel
  window, the whole figure at 3x with every tool on screen, which is the case
  that failed;
- the preview shows the whole tile at any window size, which it did not before;
- `EDITOR_MODULES` gets shorter while the editor gets larger, which is the shape
  ADR-0019 wanted: modules are domains, not screens.

Negative:

- **`/editor/character` is a dead URL.** Anything bookmarked breaks, and pre-1.0
  that is the deliberate answer rather than a redirect;
- the asset module is now two lazily-loaded workspaces behind a third route
  level, so a category change is a route change — cheap, but it does mean an
  unsaved document must guard navigation rather than assume the page stays put;
- `AssetWorkspace` is a layout component, and a layout component is a shared
  thing that every category can be tempted to bend. It has slots and no logic,
  and it should stay that way;
- **a tile has no flat pixel view any more.** Everything is judged and painted
  on the hexagon, which is right for a surface and less obviously right for an
  elevation face seen at an angle; if that turns out to matter, the flat view
  is the character's, already built, and one route away;
- **a fill and a selection existed and were taken away.** Anyone who had used
  them on a tile has lost them; the answer for that work is a real pixel editor
  and the upload button, which is what ADR-0030 said before they were written;
- two scene modes for characters is a mode, with a mode's cost: two ways to
  reach the same pixels, and a first-time author has to learn that they are the
  same pixels;
- the inspector's width, the zoom and the grid are state that lives in a tab and
  dies with it: nothing remembers how wide an author likes the column, or that
  they always work at 8x;
- moving the paint tools out of `character-editor-page.ts` touched the largest
  component in the project, and its specs moved with it.

## Rule

Everything the game is drawn from is authored in the asset editor, one category
per kind, in one frame with one set of pixel tools. A category owns its
document; it does not own a palette, an undo history, a pencil or a layout. A
new kind of drawn thing is a new category — never a new screen.

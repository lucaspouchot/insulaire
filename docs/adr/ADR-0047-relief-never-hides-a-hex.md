# ADR-0047 — Relief Never Hides a Hex

## Status
Accepted. Builds on `docs/adr/ADR-0016-isometric-projection.md`, whose transform
is what buries hexes in the first place, and on
`docs/adr/ADR-0041-a-cliff-is-stacked-in-bands.md`, which sets how tall a level
of relief is drawn.

## Context

An isometric world is drawn with `y' = y * tilt − z * elevationStep`
(ADR-0016). A raised cell therefore moves *up* the screen, over the rows behind
it, and the renderer draws back to front so that it covers them. That is the
whole point of the projection, and it is also its only real cost: with the
shipped tile set a hex loses about a third of its face to a neighbour raised
three levels, and about nineteen twentieths to one raised four. Beyond that it
is gone — an author cannot see it, and cannot click it either, because
hit-testing has always resolved to the frontmost cell drawn over the pointer.
The report that opened this was exactly that: *"il y a certaines cases qu'on ne
voit pas et sur lesquelles on ne peut pas cliquer"*.

Seeing and reaching are two different problems, and only one of them is hard.

**Seeing is free of consequence.** Nothing depends on it: showing what is behind
a mountain changes no state and resolves no click.

**Reaching is ambiguous, and no picture can resolve it.** The projection is not
injective. A cell raised four levels is drawn all but exactly on top of the cell
one row behind it — the two hexagons coincide to within a twentieth of their
height — so a pixel names two hexes and nothing in the frame says which one the
pointer means. Every rule that picks one *without* extra input picks wrong
somewhere:

- *frontmost wins* — what the renderer has always done — is what buries the hex
  behind;
- *the buried hex wins* takes the pointer off the cell in front over almost the
  whole of its face. The back edge of a plateau is the case that kills it: its
  front neighbours stand at its own height, so it has no cliff of its own to
  aim at, and it would have no clickable area left at all;
- *the ground cell under the cursor wins* — a total, bijective rule — makes
  every hex reachable and makes a mountain reachable only by its foot, which is
  where the picture says the mountain is not.

So the extra bit of intent has to come from the hand.

## Decision

**A hex the relief hides is seen by drawing the relief see-through, and reached
with a held modifier.**

**Seeing works on the occluders, never on the hidden hex.** The first
implementation painted the buried hex back over the relief, clipped to its own
hexagon. It was cheap — one blit, no search — and it was wrong on the screen:
the hex is *behind* the cliff, so painting it last puts it in front, and it read
as a green tile stuck onto a rock face rather than as a hex glimpsed through
one. Depth in this renderer is draw order (ADR-0016); anything that says
"behind" has to be drawn earlier, which leaves exactly one way to show it —
draw less of what is in front.

**Buried is measured, and the same sweep names what buries it.** A cell is
buried when at least `BURIED_COVERAGE` — 75% — of its projected top face is
covered by the silhouettes of the cells in front of it. The measure is a lattice
of sample points trimmed to the hexagon, each standing for an equal patch of it,
so the covered fraction is the covered count; every candidate that claims a
sample is recorded, and *that* list is what is drawn see-through. Fading the
cells whose pixels are actually in the way, rather than a neighbourhood, is what
keeps the rest of the mountain intact. Only cells *in front* are considered:
hexagons tile the plane, so an unraised neighbour never overlaps, and a cell
behind is drawn earlier and covered rather than covering. The answer depends on
the elevation buffer alone and is memoised per model.

**The reveal follows the pointer, with no modifier.** The frontmost buried hex
whose *top face* contains the pointer is the one revealed; the buried hexes
within `reveal.radius` rings of it are revealed with it.

**The two authored opacities are those of what stands in the way.**
`reveal.opacity` is how solidly the relief in front of the pointed-at hex is
drawn, `reveal.neighbourOpacity` the same for the ring; a cell in the way of
both takes the fainter, because the hex being aimed at wins. They are the map's
because how tall a map's relief is decides how much of it hides its own hexes —
a flat coastal map wants neither, an alpine one wants both. **Neither defaults
to `0`**: a cell drawn away entirely takes its silhouette with it, and where
nothing stands behind it that is a hole in the map rather than a hex seen
through. `0.25` and `0.55` keep the mountain legible as a ghost.

**Everything a faded cell carries fades with it** — its grid outline, its
overlay, its markers, whoever stands on it — or the map is left with bright
chrome floating over a gap.

**Reaching is a held key the player binds.** `input.peek` is an application
shortcut declared beside the six movement positions in
`engine-settings.schema.ts`, a modifier-free `KeyboardEvent.code` exactly as
ADR-0045 requires, defaulting to `KeyS` — the middle of that cluster, so the
hand that walks can hold it while the other points. Held, the pointer resolves
to the buried hex instead of the relief in front of it: hover, click, drag,
paint, all of it. Released, every existing click resolves exactly as it did.

**Not a modifier.** `Alt` was the first answer and it is the wrong one in a
browser: the platform claims it for its own menu bar and takes the focus out of
the game with it. That also settles which ADR governs this — ADR-0045 does, and
its Rule is honoured to the letter: one physical position, persisted as a code,
labelled from `key`. What is new is that the binding is *held* rather than
struck; that is a use of the vocabulary, not a change to it.

**The state comes off the keyboard, never off the pointer.** A hand pressing the
key over a still pointer sends no pointer event at all, so `CanvasView` listens
on the *window* — a canvas is not focusable — and re-resolves in place. It
ignores the key while a form field has it, ignores it inside a chord, and lets
it go on `blur` and on a rebind, because a key whose `keyup` never arrives would
leave the map holding it down.

`HexMapRenderer.resolvePointer` returns both answers at once — what a click
lands on, and what is buried there — because a host needs both on every move and
they are two questions about one point.

## Consequences

### What this buys

- **No hex is unreachable.** Whatever a map's relief does, the peek key plus the
  pointer names any hex whose face is drawn anywhere — on a key the player
  chose, so a layout or a browser that eats one is not the end of it.
- **Depth still reads.** What shows through a faded cliff is the pixels that
  were painted behind it, in the order they were painted, so the hex is seen
  where it is rather than pasted where it is not.
- **Nothing that worked changes.** Without the modifier the hit test is the
  ADR-0016 one, cell for cell; with nothing revealed the fade map is empty and
  every batch is the batch it was.
- **The cost follows the pointer, not the map.** One coverage measurement per
  revealed hex per model, taken only for the handful of cells a pointer actually
  asks about.
- **An author tunes it in the file.** `reveal` is three numbers next to `grid`,
  edited in the map settings panel, validated in Rust like every other authored
  presentation value.

### What it costs

- **A faded cell leaves the batches.** Opacity is per cell and a `Path2D` is per
  palette entry, so a see-through cell is drawn on its own at the end of its
  band. There are only ever a handful, and the band is still the unit of depth,
  so the picture is the one the batches would have made.
- **A key has to be discovered.** It is listed in Settings › Controls, under
  *View*, and the map settings hint points there; nothing on the map itself says
  so, and a player gets the reveal without being told about the peek.
- **One more universal binding.** The controls tab grows a group, and
  `keyboard-shortcuts.ts` moves from `app/settings/` to `core/` so the
  framework-free canvas view may read a code without reaching into `app/`.
- **The threshold is a judgement.** 75% covered is where a face stops being
  something a hand can aim at with the shipped geometry. A map whose art has a
  much shorter step will bury cells later than an author expects.
- **A faded cell is faded whole.** The see-through patch is a cell, not a hex
  window, so more of the cliff goes translucent than the hidden hex strictly
  needs — and an opacity near `0` shows the void behind an edge cell.
- **`WORLD_SCHEMA_VERSION` is 5.** The field is optional and defaulted, so a
  version 4 file loads unchanged.

## Alternatives rejected

**Paint the buried hex back over the relief**, clipped to its own hexagon. Built
first, and rejected on the picture: see the Decision. It also has to guess what
to draw — a cell's composed picture carries its cliff and the rows above its
surface (ADR-0038), none of which belongs in a window meant to say "this hex is
here" — where fading draws nothing new at all.

**Clip the fade to the buried hexagons**, so a cliff is see-through only where
it covers one. It removes the "faded whole" cost above and adds an inverse clip
and a second draw per occluder per opacity, for a patch the eye already reads;
worth revisiting if an author complains that too much cliff goes translucent.

**Make the buried hex win the pointer outright, with no modifier.** Rejected on
the plateau case above: the cell in front would lose its face without gaining
anything, and the two hexes coincide too closely for any tie-break inside the
overlap to be predictable.

**`Alt`, or any other modifier.** Built first, and rejected in a browser: `Alt`
opens the menu bar and moves the focus out of the page, `Ctrl` and `Meta` are
the platform's, and ADR-0045 excludes all of them from the binding vocabulary on
purpose. A bound ordinary key costs one setting and is the player's to move.

**A peek *mode* — a toolbar toggle rather than a held key.** It survives a
pointer leaving the canvas and is discoverable, but it is state that has to be
shown, remembered and cleared, and it puts the editor into a condition where
ordinary clicks silently mean something else. A held key cannot be left on by
accident.

**Cycle through the stack under the pointer** with a wheel or repeated clicks.
It needs no modifier, but it makes the answer depend on history rather than on
the pointer, and the wheel already zooms.

**Let the camera rotate instead**, so an author looks behind the mountain.
ADR-0016 chose a diagonal transform precisely so that `x` is untouched and a row
stays a depth layer; a rotation gives up viewport culling, exact hit-testing and
the batching, to solve a problem three numbers and a modifier solve.

## Rule

The key that reaches a hidden hex is a **binding, held** — never a modifier, and
never read off a pointer event. A hex hidden by relief is **seen** without
asking and **reached** by asking, and
it is seen by drawing *what is in front of it* fainter — never by drawing it
over what is in front of it, which puts it in front. Whether a hex is buried is
measured against its drawn face, never assumed from an elevation difference; how
far the reveal spreads and how solid the relief stays belong to the map. The
frontmost cell stays what an unmodified click resolves to, forever.

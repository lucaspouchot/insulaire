# ADR-0036 — An Object Is Carried, Not Placed, and Its Icon Is a Flipbook

## Status
Accepted

## Context

**The `objects` row and the `decorations` row were guessed at, and swapped.**
ADR-0028 declared five asset categories with one-line summaries and nothing
behind them, describing *objects* as "the things standing on a map" and
*decorations* as "what dresses a tile without changing it". Read together the two
describe the same thing twice and leave inventory unaccounted for.

The distinction that matters is not how decorative something is. It is **where it
lives**: a decoration stands on a hex, shares it with the characters walking over
it, and is drawn in the world (ADR-0035); an object travels in a bag, is drawn in
a panel, and never touches a cell.

Those demand disjoint fields. A decoration needs an anchor, a plane and a draw
order, because it shares a cell — none of which means anything in an inventory.
An object needs a player-facing name, a description and a stack size — none of
which means anything for a tree.

The first version of this decision gave an object a single `icon` path and said
it has "no frames". The reasoning was sound and the conclusion was not: it
refused frames because an object is not a decoration — no anchor, no plane, no
order — and "does not share a cell" does not imply "does not move". Two things
made that visible. An object with one PNG could not be authored without leaving
the editor, while the decoration screen next door has a frame per row with its own
*paint this* button — so two categories of one editor answered "where does the
picture come from?" differently. And a glinting gem is an ordinary object: a
pulsing rune, a rotating coin, none of which needs an anchor and every one of
which needs a second image.

Several shapes were rejected. **One format with a `placed` flag** produces a file
where five of nine fields are dead for any instance, and a validator that has to
say "an anchor on something carried". **Objects as a category of decoration** puts
what the player reads onto a format whose labels are deliberately not keys.
**Keeping `icon` and adding `animations` beside it** is two fields answering one
question and a still icon spelled two ways. **Giving an object the decoration's
*named* animations** would be an id that is `idle` in every file in the project.

There is a third thing objects invite and this ADR refuses: **a behaviour table**.
A potion that heals five, a key that opens door 12. Every one is a gameplay rule,
and a gameplay rule in an asset file is the beginning of the scenario logic
`CLAUDE.md` requires to be content (ADR-0004).

## Decision

**An `ObjectDefinition` is its own content file, and it is flat.**

```json
{
  "id": "gem", "schemaVersion": 2,
  "kind": "material",
  "nameKey": "game.object.gem.name",
  "descriptionKey": "game.object.gem.description",
  "frames": ["assets/objects/gem_0.png", "assets/objects/gem_1.png"],
  "frameDurationMs": 100,
  "looping": true,
  "resolution": { "width": 16, "height": 16 },
  "stackSize": 10,
  "tags": ["shiny"]
}
```

No layers, no anchor, no plane. An object is an icon and a few facts about
carrying it.

**The picture is a flipbook, flattened onto the definition.** An object has
exactly one appearance, so it is three fields rather than an array. **One frame is
a still icon**, which is what nearly every object is, and the serialiser writes no
`frameDurationMs` and no `looping` for one — a still drawing has no rate to state
and nothing to loop — so a potion file is no longer than it was.

**It is the same flipbook a decoration plays.** How long a play takes, which
frame a millisecond falls in, that a loop wraps and a one-shot holds its last
frame: written once in `crates/world/src/animation.rs` and called by both.
`MAX_FLIPBOOK_FRAMES` is named for what the cap was always about — one PNG per
frame — rather than for decorations.

**What the player reads is a key.** `nameKey` and `descriptionKey` resolve through
the loaded languages like every other displayed string, and saving creates both in
every language, empty, so the language editor lists them (ADR-0020). `name` is the
*editor's* label, exactly as it is on a character.

**An object may be incomplete and still save.** No name key and no frame are
warnings, not errors, because an object is routinely blocked out before its art
and text exist and an editor that refused to write one would send the author to a
text editor. A frame that names *nothing*, however, is a row left half-filled:
`object.missingFrame` is an error.

**`kind` and `tags` file it; they do not drive it.** `kind` is
`consumable | equipment | quest | material | other`, and no rule reads it: it is
what an inventory screen may group by and what a later query can ask for without a
naming convention. **`slot` and `equipment` travel together**, each without the
other being a warning.

**Effects, prices, damage and durability are deliberately absent.** What drinking
a potion does is scenario and combat content. When the scenario runtime lands it
will name an object by `id` and decide what happens.

**The resolver crosses the boundary, as a decoration's does.** `resolveObject` and
`previewObject` return a `ResolvedObject` — the frame index and the path already
chosen — so an inventory panel and the editor's preview cannot disagree about
which drawing is on screen.

**The editor is the small one.** `/editor/asset/objects` is a list, a form and the
icon on the shared pixel surface (ADR-0028). There is no second view, because an
object has no geometry to compose against — only a frame strip.

`OBJECT_SCHEMA_VERSION` is `2`, and nothing reads `icon`.

## Consequences

Positive:
- inventory content exists, in the vocabulary the rest of the format already
  uses: stable ids, locale keys, tags, a validated schema;
- the two rows stop describing the same thing, and the boundary between them —
  *placed* versus *carried* — is one an author can apply without reading a doc;
- an object is authored end to end inside the editor: new object, paint a 32×32
  icon, draw. No PNG has to exist first, in either category;
- an animated icon costs one more row, and the file stays readable — one frame per
  line, so a changed drawing is a changed line;
- one flipbook implementation, so a decoration and an object cannot drift on what
  plays at 250ms;
- keeping effects out means the day a scenario grants a potion, the potion does
  not have to change.

Negative:
- **an object does nothing.** Nothing picks one up, carries one or uses one. This
  is a content format ahead of the systems that will read it, and `stackSize`,
  `slot`, `frameDurationMs` and `looping` are a bet on what those systems need;
- **`frames` is flat, so an object can never have states.** If equipment ever
  needs a worn-versus-carried picture, the fix is the decoration's shape — a named
  list — which is a schema change, not a field;
- **a second way to animate is now in a second format**, widening the
  skeleton-versus-flipbook split rather than closing it;
- **`slot` is a free string**: two objects can name `mainhand` and `mainHand` and
  nothing notices, because the set of slots is not declared anywhere yet;
- **a fifth content kind** to keep in step across Rust, TypeScript, serialiser,
  validator, boundary, library service and editor;
- an object's icon canvas is separate from a character's, so nothing stops an
  author drawing a 256-pixel icon no panel will show at that size.

## Rule

An object is carried, never placed: it has an icon, a kind and the keys a player
reads, and no field of it says what using it does. What a decoration needs to
share a hex, an object does not have. Its picture is `frames` — never a single
`icon` path, never a named animation list — and the frame arithmetic behind it
belongs to `crates/world/src/animation.rs`, not to whatever is drawing.

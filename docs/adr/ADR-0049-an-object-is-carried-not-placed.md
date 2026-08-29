# ADR-0049 — An Object Is Carried, Not Placed

## Status
Accepted, and **amended by
`docs/adr/ADR-0050-an-object-icon-is-a-flipbook.md`**: an object's `icon` became
`frames`, an ordered list, and `schemaVersion` went to `2`. Everything else
below stands. The sibling of
`docs/adr/ADR-0048-a-decoration-is-anchored-to-a-hex-in-two-planes.md`, and the
second half of turning `docs/adr/ADR-0039-one-editor-for-everything-drawn.md`'s
declared rows into real ones. No existing schema changes shape; the manifest
gains one optional list.

## Context

**The `objects` row and the `decorations` row were guessed at, and swapped.**

ADR-0039 declared five asset categories with one-line summaries and nothing
behind them. It described *objects* as "the things standing on a map: props,
containers, what a player may pick up" and *decorations* as "what dresses a tile
without changing it". Read together, the two rows describe the same thing twice
and leave inventory unaccounted for.

The distinction that actually matters is not *how decorative* something is. It
is **where it lives**:

- a decoration stands on a hex, shares that hex with the characters walking over
  it, and is drawn in the world (ADR-0048);
- an object travels in a bag, is drawn in a panel, and never touches a cell.

Those two demand disjoint fields. A decoration needs an anchor, a plane and a
draw order, because it shares a cell. None of the three means anything in an
inventory. An object needs a player-facing name, a description and a stack size.
None of the three means anything for a tree.

Two shapes were rejected.

**One format with a `placed` flag.** Tempting, because both are "a picture with
an id". It produces a file where five of nine fields are dead for any given
instance, and a validator that has to say "an anchor on something carried" — a
whole class of error that exists only because the two were merged.

**Objects as a category of decoration.** Same problem in the other direction,
plus it puts the thing a player reads (a name, a description) on a format whose
labels are deliberately not keys.

There is a third thing objects invite and this ADR refuses: **a behaviour
table**. A potion that heals five, a sword that hits for three, a key that opens
door 12. Every one of those is a gameplay rule, and a gameplay rule written into
an asset file is the beginning of the scenario logic `CLAUDE.md` requires to be
content (ADR-0005).

## Decision

**An `ObjectDefinition` is its own content file, and it is flat.**

```json
{
  "id": "small_potion", "schemaVersion": 2,
  "kind": "consumable",
  "nameKey": "game.object.smallPotion.name",
  "descriptionKey": "game.object.smallPotion.description",
  "frames": ["assets/objects/small_potion.png"],
  "resolution": { "width": 16, "height": 16 },
  "stackSize": 10,
  "tags": ["healing"]
}
```

No layers, no anchor, no plane. An object is **an icon and a few facts about
carrying it** — and the icon is a flipbook whose still form is one frame long,
which ADR-0050 corrected after this ADR wrote "no frames" for a reason that only
ruled out sharing a cell.

**What the player reads is a key.** `nameKey` and `descriptionKey` resolve
through the loaded languages like every other displayed string (ADR-0023), and
saving creates both in every language, empty, so the language editor lists them
(ADR-0027). `name` is the *editor's* label, exactly as it is on a character.

**An object may be incomplete and still save.** No name key and no frame are
**warnings**, not errors. An object is routinely blocked out before its art and
its text exist, and an editor that refused to write one would send the author to
a text editor — which is the failure ADR-0022 exists to prevent.

**`kind` and `tags` file it; they do not drive it.** `kind` is
`consumable | equipment | quest | material | other`, and no rule in this project
reads it: it is what an inventory screen may group by and what a later query can
ask for without a naming convention — the role `CharacterCategory` plays for a
character (ADR-0028).

**`slot` and `equipment` travel together.** A slot is an author-owned id —
`head`, `mainHand` — and it is only meaningful on equipment. Each without the
other is a warning: the pair is a mistake, not a file the runtime cannot read.

**Effects, prices, damage and durability are deliberately absent.** What
drinking a potion does is scenario and combat content. When the scenario runtime
lands it will name an object by `id` and decide what happens; nothing about that
belongs here.

**The editor is the small one.** `/editor/asset/objects` is a list, a form and
the icon on the shared pixel surface (ADR-0039). There is no second view,
because an object has no geometry to compose against — only a frame strip
(ADR-0050).

**The `objects` summary is rewritten**, along with the `decorations` one it was
swapped with (ADR-0048).

## Consequences

Positive:

- inventory content exists, in the vocabulary the rest of the format already
  uses: stable ids, locale keys, tags, a validated schema;
- the two rows stop describing the same thing, and the boundary between them —
  *placed* versus *carried* — is one an author can apply without reading a doc;
- an object is cheap: a form and an icon, no geometry, no skeleton;
- keeping effects out means the day a scenario grants a potion, the potion does
  not have to change.

Negative:

- **an object does nothing.** Nothing picks one up, carries one or uses one:
  there is no inventory, no equipment slot machinery and no scenario to grant
  one. This is a content format ahead of the systems that will read it, and the
  fields chosen now (`stackSize`, `slot`) are a bet on what those systems need;
- **`slot` is a free string.** Two objects can name `mainhand` and `mainHand`
  and neither the validator nor the editor will notice, because the set of slots
  is not declared anywhere yet;
- **a fifth content kind** to keep in step across Rust, TypeScript, serialiser,
  validator, boundary, library service and editor;
- an object's icon canvas is separate from a character's, so nothing stops an
  author drawing a 256-pixel icon that no panel will show at that size.

## Rule

An object is carried, never placed: it has an icon, a kind and the keys a player
reads, and no field of it says what using it does. What a decoration needs to
share a hex, an object does not have.

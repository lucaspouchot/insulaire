# ADR-0028 — Characters Are Definitions Plus Customisations, Resolved in Rust

## Status
Accepted

## Context

The game needs a player character the player can make choices about — gender,
hair colour, height in the first instance. It will also need merchants,
goblins, skeletons and, eventually, a dragon. Every one of those has to be
drawn, and most of them have something that varies between two of the same kind.

The obvious first move is to write the thing that is actually asked for:

```text
PlayerCharacter { gender, hair_colour, height }
```

That is a dead end, and predictably so. `gender` means nothing to a skeleton;
`horns` means nothing to a merchant. A second type per category — `NpcAppearance`,
`MonsterAppearance` — multiplies the renderer by the bestiary, and the day a
goblin needs a hair colour there are two implementations of hair colour. It also
puts a **gameplay word in the renderer**, which is the failure mode `CLAUDE.md`
names: the engine must not contain content-specific branches.

Three shapes were considered.

**One type per kind of character.** Simple to write, impossible to grow: the
renderer, the validator and the editor all gain a branch per category.

**A scripting hook per character** — a function that returns what to draw. It
handles everything and is a non-goal (`CLAUDE.md`: no unrestricted scripting
language), unreviewable as content, and undrawable in an editor preview.

**A generic definition resolved into a flat drawing list.** More machinery than
the first feature needs, and the only one where a goblin costs a JSON file.

There was also a smaller question with a large consequence: what vocabulary
describes "the choices a character offers". A character's `hair colour` is a
colour picker; its `height` is a slider; its `armour` is a list of options.
That is exactly `ControlDefinition`, which ADR-0025 already introduced for
settings and which `control-field` already renders.

## Decision

**A character is a `CharacterDefinition` plus a customisation, resolved into a
`ResolvedCharacter`.**

```text
CharacterDefinition + values ──> resolve() ──> ResolvedCharacter ──> renderer
```

One pipeline for every category. There is no player branch anywhere in it, and
the renderer never reads `category` — a category is how an author files a
definition, not how it is drawn.

**A definition is two lists.** `parameters` are the choices it offers;
`layers` are the pieces it is drawn from, back to front. A layer holds
`variants`, and a variant declares the parameter values it answers to (`when`),
where it is drawn (`rect`), and what it draws (`visual`). Nothing in the model
knows what a body, a head or a wing is: those are ids an author types.

**A parameter is a `ControlDefinition`** — the settings vocabulary of ADR-0025,
reused whole. Values are resolved by the *same function* (`resolve_controls`),
so an unknown option, a wrong type or an out-of-range number means the same
thing for a character as for a setting, and the character-creation screen will
be built from the component that renders a volume slider. `scope` is the one
field that does not carry over: it is not part of the character format.

**The first matching variant wins.** Author order is priority, which makes
"most specific first" a rule visible in the file. A layer with no match draws
nothing, which is how an optional piece — a helmet — is authored.

**A definition declares `procedural` or `assetComposition`, and validation
holds it to it.** Both modes go through the same resolver and the same
renderer; the declaration exists so that "this character is built from images"
is a fact about the file rather than something discovered by reading every
variant.

**One binding acts on geometry: `scaleParameter`.** It names a numeric
parameter that scales the whole character about the ground line. Without it,
height would multiply every variant of every layer — the combinatorial
explosion that makes appearance systems collapse. Everything else varies by
swapping a variant.

**Geometry is a unit square**, `[x, y, width, height]` in `0..1`, y down. One
definition therefore draws as a 32-pixel map token or a full-height portrait
with no second set of numbers.

**Colours resolve in Rust.** A variant's colour is either written in the file or
read off a parameter, and a `ResolvedCharacter` carries the literal. The
renderer fills shapes and blits images; it makes no decision about appearance
(ADR-0001).

**The boundary carries two resolvers.** `resolveCharacter(id, values)` resolves
registered content — what a game will call. `previewCharacter(json, values)`
resolves a definition passed in, which is what the editor needs for content it
is still writing. Resolution is total, so an unfinished definition previews as
whatever it currently is.

**The editor is generic.** `/editor/character` creates and edits definitions of
any category; the player's is simply the first one this project ships. Its
preview is the real `control-field`, the real resolver and the real renderer, so
what an author sees is what a player gets.

**Characters are content the manifest lists**, like worlds and tile sets:
`project.characters`, validated as loaded before a project loads.

## Consequences

Positive:
- a goblin, a merchant and the player are the same structures, the same
  validator, the same resolver and the same editor — a new creature is a JSON
  file, not a code change;
- the preview cannot flatter the result: it is the shipping pipeline;
- one implementation of "what is this value, really", shared with settings;
- animation, directions and poses have somewhere to go — a layer resolves to *a
  visual*, so frames are a change inside `LayerVisual` rather than a change to
  the shape of a definition;
- validation catches what a renderer would otherwise discover silently: a
  condition on a parameter nobody declared, a colour bound to a number, a sprite
  with no path, a box of zero size.

Negative:
- more machinery than "the player has three sliders" needs, and every one of
  those three sliders now costs a parameter *and* the layers that read it;
- the shape vocabulary is closed — `rect`, `ellipse`, `triangle` — so a
  procedural character that wants a curve needs a new primitive, which is a code
  change and an ADR;
- one variant per combination is still the rule for anything but scale: a
  character with three hair styles and two genders needs six variants if the two
  interact;
- `ControlDefinition` carries `scope`, which characters ignore — a field that
  means something in one file and nothing in another;
- nothing *plays* a character yet: entities on the map are still drawn from
  `EntityTemplate` visuals, and no screen offers a player these choices. The
  definitions are authored and validated but not yet worn.

## Rule

Character appearance is authored as a `CharacterDefinition` and resolved by
`insulaire_world::character`. No host resolves a character itself, and no
category — player, NPC, monster — gets a type, a pipeline or an editor of its
own.

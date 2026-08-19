# Conceptual Data Model

Definitions describe *authored content*; state describes *a play session*. The
two are strictly separate (ADR-0003). The wire format for definitions is
specified in `docs/content-format.md`; the boundary DTOs in `docs/wasm-api.md`.

## WorldDefinition

An authored world contains at minimum:

- `id`
- `schemaVersion`
- `width`
- `height`
- `orientation`
- `projection` — presentation only; carried, never interpreted by the engine
- `tileSetId`
- `defaultTile`
- `tiles`
- `locations`
- `entities`
- `links` — cells that send the player to another map (ADR-0017)
- `zone` — the group of maps this one is simulated with; resolves to the
  project's default when absent (ADR-0021)
- `metadata`
- *(planned)* `scenarioId`

The map is not derived from a seed.

Cells are stored **sparsely**: `tiles` lists only the cells that differ from
`defaultTile`. The runtime expands this once, at load, into a dense buffer.

## ProjectDefinition

A world knows its tile set and the maps its doors lead to, but nothing in a
world says which files make up a *game* or where a session starts. That is the
project manifest (`content/project.json`): `id`, `schemaVersion`, `startWorld`,
the `zones` its maps are grouped into, and the `tileSets` and `worlds` it ships,
each as `{ id, path }`. A delivered client build boots from it (ADR-0018); the
editor regenerates it whenever the set of maps or zones changes.

The manifest also lists the project's **characters**, each as `{ id, path }`:
the definitions that say how a kind of character is drawn (ADR-0028). A project
may ship none.

The manifest also names the game's **settings** declaration
(`content/settings.json`): sections, groups and fields described with the same
control vocabulary the application's own settings use. The engine validates and
resolves them; it never interprets one, and a resolved set travels with the game
it created (ADR-0025).

The manifest also declares the game's **languages**: `locales.default` and
`locales.languages[]`, each `{ id, name, files }` where a file's `id` is the
namespace prefixed to its keys. Text is not a field of any definition — every
string a screen displays is a key resolved against a language, and the files
holding them are content like the maps (ADR-0023).

A `zone` is `{ id, name }` and nothing more: the *first* declared is the default,
and a world naming no zone belongs to it, so "unzoned" is not a state a map can
be in (ADR-0021). Zones live here rather than on the maps because a zone has to
exist before a map is put in it, and because a tick will advance a whole zone —
which means resolving several maps at once, from the manifest that lists them.

## TileDefinition

A tile is a palette entry living in a `TileSetDefinition`, not a map cell:

- identity (`id`, `name`, `terrain`)
- sprite/tile source (`visual.visualId`, with `visual.fallbackColor`)
- tags
- movement cost — **`0` means impassable**
- gameplay properties
- *(planned)* render layer

Map cells (`PlacedTile`) carry a position, a reference to one of these ids, and
an `elevation` — relief the renderer draws in isometric mode and the rules
ignore (ADR-0016).

## EntityDefinition

A placed entity contains:

- hex position (`at`)
- template (`templateId`)
- tags
- persistent properties
- behaviour reference — *supplied by the template*
- asset reference — *supplied by the template*

Templates currently live in a built-in registry
(`crates/world/src/template.rs`) rather than in content files. The indirection
is what matters: worlds reference an id, so templates can become content later
without touching a single world file.

## CharacterDefinition

*How a kind of character is drawn, and what may be chosen about one.* Authored
content, one file per definition, listed by the project (ADR-0028).

```text
CharacterDefinition
  id, name, category
  resolution     the pixel canvas its sprites are authored on
  parameters[]   ControlDefinition — the same vocabulary as settings
  layers[]
    id
    parent, parentAnchor    which layer it hangs off, and the joint it
                            is placed from
    anchors[]               id, at[x,y] — joints, from this layer's origin
    variants[]
      id, when{ key: value }, rect[x,y,w,h] from the joint,
      order (draw order override), sprite{ asset, tint? }
  animations[]
    id, name, frames, frameDurationMs, looping
    mirrorOf                this animation is another one, flipped
    pose{ key: value }      what it draws, for its whole length
    poses[]                 frame, then the values that frame sets
    tracks[]
      node                  a layer id
      keyframes[]           frame, offset[x,y], interpolation
```

`parent` makes the layers a **tree**, and the tree **places** the character: a
child's box is measured from the joint it hangs off, so a sprite drawn to sit on
that joint is `[0, 0, w, h]` and moving a parent moves everything under it
(ADR-0034). A root hangs off nothing, so its box is a canvas position.

The tree is *not* the draw order: layers are drawn in author order, back to
front, so a cape hangs off the body and is drawn behind it — until a variant's
`order` steps out of that order, which is how the same cape drapes over the near
shoulder when the character is seen from the side.

An animation is two statements. Its **tracks** hold offsets from the rest pose:
a node with no track is not still — it follows its parent, because offsets
compose down the tree and a node's own keyframe *adds to* what it inherits.
That is what keeps a character with thirty layers and ten animations from
storing three hundred positions.

Its **pose** holds what the character is drawn *as*. Those values join the
customisation while it plays, and layers pick them up through the `when` they
already have — so a `when` key names a parameter or a pose key and a variant
does not know which (ADR-0033). One line says a whole animation is the side
view; four lines say which leg is forward. And `mirrorOf` makes a whole
animation the reflection of another, so walking right is one line rather than a
second cycle to keep in step.

A definition describes a *family*; a set of chosen values — a **customisation**
— describes one member of it. Neither is runtime state: a customisation is a
plain map of values, which is what lets it be authored, saved or chosen at
character creation without a type of its own.

```text
CharacterDefinition + values + (animation, timeMs) ──> resolve() ──> ResolvedCharacter ──> renderer
```

`ResolvedCharacter` is the only thing a renderer sees: a canvas size and an
ordered list of whole-pixel boxes, each with an image to blit and a literal
tint. It holds no definition, no lookup and no category — the same pipeline
draws the player, a merchant and a dragon.

The placement and the animation's offset are **already in each box**, which is
why neither changed a renderer. The payload carries the `origin` each box was
measured from, the offset that was applied, and the `pose` it came from —
animation, frame and the pose values in force — for an *editor* to read; the
renderer ignores all three,
and never learns that time exists. The one exception is `mirrored`: reflecting
the boxes without reflecting the pixels inside them is a character taken apart
and put back wrong, so the renderer flips the canvas as a whole.

A character's **size** is its canvas, not a scale factor: a rat is authored at
32×32 and a dragon at 256×256, and a host zooms each by a whole number
(ADR-0029).

**No type here is specific to the player.** The player's character is one
`CharacterDefinition` among the project's, and the reason to keep it that way is
that the alternative — a `PlayerAppearance` beside an `NpcAppearance` — is a
renderer multiplied by a bestiary.

## SpriteDocument

*The pixels of one image, while an author is editing them.* Editor-only, and the
only model here that is not content: it is what a PNG looks like between being
read and being written (`apps/web/src/content/sprite-document.ts`, ADR-0030).

```text
SpriteDocument
  width, height        the image's own pixel size
  pixels               RGBA, row-major, one byte a channel
  history              up to 32 strokes, in memory, never persisted
```

A **stroke** is one thing the author did — `begin()`, any number of plots, then
`end()` — and it is the unit undo works in. Painting writes opaque, erasing
writes fully clear, and a drag is joined into a line, so the buffer never holds
the partial alpha that a later tint could not recolour.

Nothing about it crosses the engine boundary. Rust decides what a character is
drawn from; the bytes it is drawn *with* reach the engine as files, exactly as
they would from any other tool.

---

## ScenarioDefinition

*Not implemented in the MVP.* The scenario will contain acts, phases,
objectives, flags, timers, triggers, events and consequences (ADR-0005). Phases
5 and 6 of the tick pipeline are already reserved for it and are explicit no-ops
in `crates/simulation/src/tick.rs`.

References should use stable IDs rather than fragile array indices or positions.

## Runtime State

Definitions are immutable during a play session. The runtime maintains mutable
state:

```text
GameState                        crates/simulation/src/state.rs
├── tick                         u64, one per accepted action
├── worldId                      which authored world is being played
├── seed                         owned by the engine, never by JavaScript
├── grid          ── Arc ──────> WorldGrid   (immutable authored reference data)
├── links                        the current map's doors, copied from content
├── entities                     EntityStore: compact handles + positions
├── rngState                     serialisable PCG32
├── scenarioState?               (planned)
└── combatState?                 (planned)
```

The authored `WorldGrid` is shared behind an `Arc` rather than copied: it is
reference data, so a play session borrows it instead of owning a duplicate.

`worldId`, `grid` and `links` change together when the player walks through a
door: `GameState::enter_world` rebuilds the state from the target world and
carries `tick`, the RNG stream and the arrival position across. The player
entity is the one the target map authors, so every map stays independently
playable (ADR-0017).

### WorldGrid

The flattened runtime view of a world:

- `width`, `height`
- `palette: Vec<ResolvedTile>` — the tile set, flattened
- `cells: Vec<u8>` — one palette index per cell, row-major in offset
  coordinates
- `elevations: Vec<i8>` — one elevation per cell, in the same layout

`cells` and `elevations` are exactly the buffers handed to JavaScript as a
`Uint8Array` and an `Int8Array`, so the file coordinate, the buffer index and the
rendered position all agree.

### EntityStore

Runtime entities are addressed by a compact `EntityId` handle; the authored
string id travels alongside so saves, logs and the UI can refer to entities
stably.

## Editor state

The editor owns a third model, `WorldDocument`
(`apps/web/src/content/world-document.ts`), and it is neither of the above: a
world being *authored* has no tick, no RNG and no entity handles, and every
cell is freely mutable. It holds a dense `Uint8Array` of palette indices and a
dense `Int8Array` of elevations — the same layout the runtime and the renderer
use — plus the authored `projection` and `zone`, and re-sparsifies on export.

The editor holds **one document per map**, not one document
(`ProjectStoreService`, `apps/web/src/app/services/project-store.service.ts`),
together with the manifest and the loaded tile sets. Map links require it: a
door names another map, so authoring one means having the others in hand, and
the whole set is what `validateLinks` judges. The store also owns which map is
open, whether anything is dirty, and the `localStorage` mirror — which only the
dev build writes (ADR-0018).

Editor state and runtime state never mix. The only things that cross between
them are a `WorldDefinition` and a `ProjectDefinition`: files.

## Why

This supports:
- multiple playthroughs using the same world
- compact saves
- editor-driven content
- automated validation
- future content migrations

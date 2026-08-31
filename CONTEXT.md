# Insulaire — vocabulary

The words this project uses for its own things, and the two it deliberately
reserves. Written for the reader who is about to name something and wants to
know whether a name already exists for it.

This file is the glossary, not the architecture: what the project *decided* is
in `docs/adr/`, and what it is *built from* is in `docs/architecture.md`. A term
here that carries a decision cites the ADR that holds it.

## Reserved calls

Two words in this codebase mean one thing and not the obvious other. Both were
written down because a reader who does not know will otherwise correct the code
in the wrong direction.

### **session** means a game in progress — never an editor's

A *session* is a run of the game: the state a save restores and the thing that
outlives the route a player navigated away from
(`docs/adr/ADR-0023-session-outlives-the-route.md`). It is never the editor's
open documents.

The editor's equivalent is a **draft set**. `app/editing/` describes itself in
prose as an editing session — that reads correctly and is where the reader
arrives from — but the word appears in nothing it *exposes*: no identifier, no
signal, no message, no locale key. A member called `session` in the editor is
therefore always a mistake, and one in the play code always means a game.

### editor chords read `event.key`; game actions read `event.code`

Both are right, for different jobs, and `core/keyboard-shortcuts.ts` holds both.

A **game action** is a *position* on the keyboard. WASD is a shape under the
hand, so a binding stores `KeyboardEvent.code` and an AZERTY player's north-west
key is `KeyW` whatever letter is printed on it
(`docs/adr/ADR-0032-shortcuts-use-physical-keys.md`).

An **editor chord** is the *printed letter*. Ctrl+Z is a name, not a place: a
French author presses the key marked Z to undo, so `undoRedoIntent` reads
`event.key`. ADR-0032's scope is rebindable one-key game actions and does not
govern this.

Seeing the two side by side and "fixing" one to match the other is the mistake
this section exists to prevent.

## The world

- **hex** — one cell of the map. Addressed in *offset* coordinates
  (`col`, `row`) at the edges and *axial* inside the maths
  (`docs/adr/ADR-0011-hex-coordinate-model.md`).
- **world** — one authored map: its hexes, its palette, its links to other maps
  (`docs/adr/ADR-0033-a-map-is-a-set-of-hexes.md`). The editor calls the screen
  the *map editor*; the document is a world.
- **tile** — what a hex is made of: terrain, art, movement cost, tags. Tiles
  come in a **tile set** (`docs/adr/ADR-0006-assets-tilesets.md`).
- **decoration** — a thing that *stands on* a hex and shares it: a tree, a
  chest. It has an anchor, a plane and an order
  (`docs/adr/ADR-0035-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
- **object** — a thing that is *carried*: a potion, a key. It has an icon and a
  stack size, and never a position on the map
  (`docs/adr/ADR-0036-an-object-is-carried-not-placed.md`).

Decoration and object are opposites on purpose, and the pair is the reason
neither is called an "entity".

## Drawing

- **flipbook** — an animation that is a list of images with a rate and a loop
  flag. A decoration animation is one; an object's icon is one. Its arithmetic
  is `content/flipbook.ts`, mirroring `crates/world/src/animation.rs`; **what is
  drawn** always comes from the Rust resolver.
- **flipbook clock** — play, pause and scrub over a flipbook, in the editor.
  `app/editing/flipbook-clock.ts`. A running game has no clock: it is driven by
  the tick (`docs/adr/ADR-0003-tick-simulation.md`).
- **canvas surface** — the one policy every canvas in the application shares:
  how dense its backing store is, the whole zoom a drawing fits its frame at,
  and the rungs a zoom button steps through. `renderer/canvas-surface.ts`. Not a
  component, and not a canvas: it takes a `CanvasRenderingContext2D`.
- **sprite** — one authored image. A **sprite document** is one open for
  painting, with its own undo history (`content/sprite-document.ts`).

## Authoring

- **draft** — one authored document as the editor holds it, before it is
  written. A character definition, a decoration, a settings declaration. It has
  an `id`, and that id is what everything else keys on.
- **draft set** — the editing session: the drafts held, which one is open, what
  is unwritten, and the load and save choreography. `app/editing/draft-set.ts`.
  A single-document editor holds one whose list is length 1.
- **draft source** — the seam under a draft set: everything about a *kind* of
  content that the session must not know — how one is read, validated,
  serialized, written and declared. `app/editing/draft-source.ts`.
- **unsaved** / **dirty** — what a *draft* owes the disk, and the draft set is
  the only thing that decides it: a draft is dirty when its definition differs
  from the file **or** an image it owns is unwritten. There is no second answer
  to that question. There is a second *question*, which the unload guard also
  asks: a painted buffer that no draft names any more — a frame repointed after
  it was drawn on — is still an author's work and still unwritten, and it is
  not a dirty draft. `unsavedSprites` is that one, and it is named differently
  on purpose.
- **manifest** — `content/project.json`: which files make one game
  (`ProjectDefinition`). A kind is *declared in the manifest* when it lists one
  entry per draft; the settings file and the title screen live at a fixed path
  and are not. The flag a draft source carries answers the narrower question of
  whether **saving** this kind can move the manifest, which is not the same: a
  tile set is listed, but the tile editor creates and removes none, so saving
  one cannot move it either — and must not flush an edit the map editor next
  door has left half-finished.
- **content library** — what holds a kind's registered definitions and puts them
  back after a content reset (`app/services/content-library.ts`). A peer of the
  draft set, not a part of it: a running game has libraries and no drafts.
- **workspace** — the authoring content directory on disk, reached through the
  local authoring server (`docs/adr/ADR-0019-authoring-content-workspace.md`).
  Also the name of an asset editor screen (`character-workspace`), which is a
  collision the code lives with; the service is `ContentWorkspaceService` and
  the screens are `*-workspace.ts`.
- **key** — a locale key. Player-facing text is never authored in place: a file
  names a key and the language editor gives it text
  (`docs/adr/ADR-0020-localised-content-keys.md`). Saving a draft creates every
  key it names, empty, in every language.

## Simulation

- **tick** — one advance of the world, caused by one valid player action. Its
  phase order is fixed (`docs/adr/ADR-0003-tick-simulation.md`).
- **engine** — the Rust side, reached across the WASM boundary. It owns the
  `GameState`, the rules and every verdict about content
  (`docs/adr/ADR-0001-separation-ui-engine.md`,
  `docs/adr/ADR-0012-shared-content-validation.md`).
- **resolve** / **preview** — the engine turning a definition into what to draw.
  *Resolve* names one it already holds; *preview* takes one the editor is still
  editing. The editor never assembles a drawing itself.
- **report** — a `ValidationReport`: the engine's verdict, as issues with a
  severity and a code. An *error* stops a write; a *warning* does not.

# ADR-0006 — Content References Assets by Stable Id, Never by Path

## Status
Accepted

## Context

Authors must be able to add their own textures, sprites and audio. The obvious
thing — writing a file path into the map — makes the map break when a file is
renamed, makes two maps disagree about which file a tile uses, and makes the
runtime resolve a path it cannot validate.

There is a second question underneath: what a *tile* is. The first answer here
described a tileset as a source image plus a cell size and a list of regions cut
out of it — the sprite-sheet model every 2D engine starts from. That model did
not survive contact with authored relief: a raised hexagon is a top face plus the
faces its drop exposes, drawn separately, and slicing them out of one sheet
re-raises the question of what to do when a face is missing.

## Decision

**Assets have stable ids, and content references the id.** A world tile stores a
`tileId`; a tile set is what turns that id into pictures. Renaming a source file
does not break a map as long as the id is stable, and a map is never edited to
repaint a tile.

**A tile set is a palette plus one authored pixel grid.**
`TileSetDefinition { id, schemaVersion, name, art, tiles }`. The grid — `art` —
is declared once per set rather than per tile, because tiles sit next to each
other on the same map and two tiles drawn at two sizes cannot both be right. What
each tile is drawn from, and how a drop is stacked, is ADR-0026's decision; this
one only fixes that the map names an id and the set answers it.

**A tile carries a `fallbackColor`.** Art is optional at every level, and colour
is what a cell shows where art does not reach — which is what "not drawn yet"
looks like on this map.

**Paths inside content are validated, not resolved, by the engine.** It checks
that a path is relative, has no parent segment and is not a URL; whether the file
exists is the host's business, because no build of the engine can see a disk.

## Consequences

Positive:
- renaming or repainting a source file never touches a world file;
- a map is portable between tile sets that declare the same ids;
- the engine validates references without needing a filesystem;
- an unfinished tile set still loads and still draws something.

Negative:
- an id is one more thing to keep unique, and a dangling one is only caught by
  validation;
- the editor must provide asset import and validation, or ids are typed by hand;
- the engine cannot tell a correct path from a path to a file nobody shipped, so
  a missing image is a runtime observation rather than a load error.

## Rule

Content names an asset by id. A file path appears in a content file only as the
value a tile set, a character layer or a flipbook frame resolves that id into —
never in a map, and never as a reference one content file makes to another.

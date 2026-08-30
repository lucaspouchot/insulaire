# ADR-0013 — Project the Hex Plane at Render Time, Author the Mode per World

## Status
Accepted

## Context

The renderer drew the world straight down: a hex centre was a world-space point,
and world space was screen space up to the camera transform. A top-down grid is
right for an editor and wrong for a game that wants readable relief — nothing
distinguished a mountain from a green field but its colour, and the authored
`elevation` field had no visible effect at all.

Three ways to get an isometric look were considered.

**A rotated axonometric basis** — the classic 30° square-tile isometric — was
rejected. Rotating a pointy-top hex grid produces hexagons of six different
apparent edge lengths, destroys the horizontal run of odd-r rows, and turns the
back-to-front draw order into a diagonal sweep. Every property ADR-0011 buys
would have to be re-derived in pixel space.

**A second layout implementation** beside `HexLayout` was rejected as
duplication: two copies of the hex↔pixel maths that must not drift, for what is a
single affine transform of the output.

**Baking the projection into the engine** was rejected outright. Pixels do not
exist in Rust (ADR-0011), and a projection depends on camera and zoom, not on
game rules.

Where the mode lives was the second question. A per-session UI toggle makes the
same world look like two different games depending on which button was last
pressed; the world is authored content (ADR-0002), and how it is meant to be seen
is part of what the author decides.

## Decision

**Projection is an affine transform applied to world-space points on their way to
the canvas.** `HexLayout` keeps producing the canonical top-down hex plane,
unchanged and still the only place hex↔pixel maths lives. `Projection`
(`apps/web/src/renderer/projection.ts`) maps that plane to the drawing plane:

```text
  x' = x
  y' = y * tilt - z * elevationStep      z = the cell's authored elevation

  top-down    tilt = 1, elevationStep = 0     (identity)
  isometric   tilt and step come from the tile set's authored pixel grid
```

**The tile set is the authority on those two numbers**, not this ADR. A surface
image *is* the projected top face's bounding box and one authored band *is* one
level of relief, so `Projection.from` derives both from the grid a set declares
(ADR-0026). Deriving them the other way round would stretch drawn art into
constants chosen before anything was drawn.

The transform is diagonal, so it inverts exactly: `cellAtScreen` unprojects and
hit-testing stays pixel-accurate at any zoom. Only the vertical axis is
foreshortened, so odd-r rows stay horizontal, a row is still a depth layer, and
painter's ordering is `row 0 → row height-1`.

**The mode is authored.** `WorldDefinition.projection` is `"topDown"` (the
default) or `"isometric"`. It is carried through validation and republished on
`WorldView.projection`, and the engine never reads it — content the engine
transports but does not interpret.

**Elevation reaches the renderer as a packed buffer.** `elevationBuffer(worldId)`
returns one `i8` per cell, row-major in offset coordinates, mirroring
`terrainBuffer`. One signed byte is the range validation enforces.

Batching is per row rather than per viewport when tiles can overlap: an elevated
tile is drawn as a top face plus side walls, so a frame costs
`visible rows × palette entries` fills instead of `palette entries`. In top-down
mode the single-batch path of ADR-0005 is unchanged.

## Consequences

Positive:
- the engine, the coordinate model and the content schema's geometry are
  untouched: a projection change is a change to one small TypeScript module;
- `elevation` becomes visible, so authoring relief has a point;
- hit-testing, culling and the camera keep working by construction, because the
  transform is invertible and axis-aligned;
- the editor and the runtime cannot disagree about how a world looks, because
  both read the mode from the same file.

Negative:
- isometric mode gives up whole-viewport terrain batching. The cost is bounded by
  visible rows and only paid in isometric mode, but a very wide viewport at low
  zoom issues noticeably more `fill()` calls;
- entities are drawn interleaved by row, which orders them against terrain but
  not against each other within a row. Fixing this means a real depth sort, and
  is local to `drawRow`;
- authored elevation is clamped to a signed byte; more than 127 steps of relief
  would need a wider buffer and a schema bump;
- raising a cell moves it up the screen and over the rows behind it, which is the
  point of the projection and is also how a hex becomes impossible to see or
  click. ADR-0034 is the answer to that, and it exists because of this decision.

## Rule

Presentation transforms belong in `apps/web/src/renderer/`; `HexLayout` describes
the top-down hex plane and nothing else, and no projection maths may enter Rust.
The numbers the transform uses come from the authored tile grid, never from a
constant in the renderer.

# ADR-0016 — Project the Hex Plane at Render Time, Author the Mode per World

## Status
Accepted

## Context

The renderer drew the world straight down: a hex centre was a world-space point,
and world space was screen space up to the camera transform. A top-down grid is
the right thing for an editor and the wrong thing for a game that wants readable
relief — nothing on screen distinguishes a mountain from a green field beyond its
colour, and the authored `elevation` field (`PlacedTile.elevation`) had no visible
effect at all.

Three ways to get an isometric look were considered.

**A rotated axonometric basis** — the classic 30° square-tile isometric — was
rejected. Rotating a pointy-top hex grid produces hexagons of six different
apparent edge lengths, destroys the horizontal run of odd-r rows, and turns the
back-to-front draw order into a diagonal sweep. Every property ADR-0014 buys —
row-major buffers agreeing with screen position, exact offset↔axial conversion —
would have to be re-derived in pixel space.

**A second layout implementation** (`IsometricHexLayout` beside `HexLayout`) was
rejected as duplication: two copies of the hex↔pixel maths that must not drift,
for what is a single affine transform of the output.

**Baking the projection into the engine** was rejected outright. Pixels do not
exist in Rust (ADR-0014), and a projection depends on camera and zoom, not on
game rules.

Where the mode lives was the second question. A per-session UI toggle makes the
same world look like two different games depending on which button was last
pressed; the world is authored content (ADR-0003), and how it is meant to be seen
is part of what the author decides.

## Decision

**Projection is an affine transform applied to world-space points on their way to
the canvas.** `HexLayout` keeps producing the canonical top-down hex plane,
unchanged and still the only place hex↔pixel maths lives. `Projection`
(`apps/web/src/renderer/projection.ts`) maps that plane to the drawing plane:

```text
  x' = x
  y' = y * tilt - z * elevationStep      z = the cell's authored elevation

  top-down    tilt = 1,    elevationStep = 0     (identity)
  isometric   tilt = 0.55, elevationStep = 0.30 * hex size
```

The transform is diagonal, so it inverts exactly: `cellAtScreen` unprojects and
hit-testing stays pixel-accurate at any zoom. Only the vertical axis is
foreshortened, so odd-r rows stay horizontal, a row is still a depth layer, and
painter's ordering is `row 0 → row height-1`.

**The mode is authored.** `WorldDefinition.projection` is `"topDown"` (the
default) or `"isometric"`. It is carried through validation and republished on
`WorldView.projection`, and the engine never reads it — it is content the engine
transports but does not interpret, exactly as `metadata` is.

**Elevation reaches the renderer as a packed buffer.** `elevationBuffer(worldId)`
returns one `i8` per cell, row-major in offset coordinates, mirroring
`terrainBuffer`. One signed byte per cell is the range validation enforces
(`world.elevationOutOfRange`).

Batching is per row rather than per viewport when tiles can overlap: an elevated
tile is drawn as a top face plus side walls, so a frame costs
`visible rows × palette entries` fills instead of `palette entries`. In top-down
mode the single-batch path of ADR-0007 is unchanged.

## Consequences

Positive:
- the engine, the coordinate model and the content schema's geometry are
  untouched: a projection change is a change to one 60-line TypeScript module;
- `elevation` becomes visible, so authoring relief has a point;
- hit-testing, culling and the camera keep working by construction, because the
  transform is invertible and axis-aligned;
- the editor and the runtime cannot disagree about how a world looks, because
  both read the mode from the same file.

Negative:
- isometric mode gives up whole-viewport terrain batching. The cost is bounded by
  visible rows (tens, not thousands) and only paid in isometric mode, but a very
  wide viewport at low zoom issues noticeably more `fill()` calls than top-down;
- entities are drawn interleaved by row, which orders them against terrain but
  not against each other within a row; two entities on the same row with very
  different elevations may overlap in the wrong order. Fixing this means a real
  depth sort, and is local to `drawRow`;
- authored elevation is clamped to a signed byte. A world needing more than 127
  steps of relief would need a wider buffer and a schema version bump;
- adding `projection` to the world file changes the canonical serialisation, so
  every checked-in world gains a line. Reading an older file without the field
  still works — it defaults to `topDown`.

## Rule

Presentation transforms belong in `apps/web/src/renderer/`; `HexLayout` describes
the top-down hex plane and nothing else, and no projection maths may enter Rust.

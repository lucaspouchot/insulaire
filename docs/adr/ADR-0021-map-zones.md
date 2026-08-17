# ADR-0021 — Group Maps into Zones, the Unit of Simulated Scope

## Status
Accepted

## Context

A project is a set of maps linked by doors (ADR-0017), and nothing above the
map. That is enough to walk from a valley into a refuge, and not enough to say
what the rest of the world is doing meanwhile: today a tick advances the map the
player stands on, and every other map is frozen until someone walks into it. A
hunter three maps away never moves, never arrives, never gives up — the world
only exists where the camera is.

The requirement is that a tick advance *a region*: every entity of the region
the player is in moves, not only the entities sharing the player's map. That
needs a name for "these maps belong together", and the name has to be content —
the region a map is in is authored, like everything else about the world
(ADR-0003).

**Deriving regions from doors** — a connected component of the link graph — was
rejected: it makes an authored notion an accident of geometry, two areas joined
by one door would collapse into a single region, and adding a door would
silently change what the tick simulates.

**A free-text label on each map** was the first implementation of the field and
is wrong for the same reason a tile id is not free text: a value that only
exists because some map spells it cannot be created before it is used, cannot be
renamed in one place, cannot be validated, and a typo silently produces a new
region of one map. It also made the field editor-only, which this ADR reverses:
zones were documented as organisation "no rule may depend on", and the tick will
depend on them.

**A `zone` field required in every world file** was rejected as a breaking
schema change for something a project can always answer: a map that names no
zone belongs to the project's default one.

## Decision

**Zones are declared by the project.** `ProjectDefinition.zones` is an ordered
list of `ZoneDefinition { id, name }`, and `WorldDefinition.zone` names one:

```json
// project.json                        // worlds/demo_world.json
{ "zones": [                           { "id": "demo_world",
    { "id": "valley", "name": "Valley" }  "zone": "valley", … }
  ], … }
```

**Every map belongs to exactly one zone.** The field stays optional in the file
and resolves to the project's default zone — the *first* declared, or the
implicit `default` when a project declares none. "Unzoned" is not a state a map
can be in; `ProjectDefinition::resolve_zone` is where absent becomes default,
and it is the only place that rule lives.

**A zone id is a cross-file reference, checked like a door's target.** A world
file alone cannot say whether its zone exists, so `validate_project_zones` runs
over the loaded set and reports `world.unknownZone`, next to
`project.duplicateZone` and `project.missingZoneId` from the manifest's own
validation (ADR-0015: the verdict is Rust's, for editor and runtime alike).

**A zone is the unit of simulated scope.** Phase 4 of the tick (ADR-0004,
"world-system tick") advances the maps of the player's zone; maps in other zones
do not advance. This is the reason zones exist, and it is *not implemented yet*
— the field, its declaration and its validation are, so content authored now
carries the grouping the tick will read. Nothing else about the pipeline changes:
the tick still holds no content registry (ADR-0017), so widening what it
advances means the host hands it the zone's grids, never that it fetches them.

## Consequences

Positive:
- the world can live outside the player's map without the tick learning to load
  content, which ADR-0001 and ADR-0013 exist to prevent;
- a zone is created before it holds anything, so an author lays out regions and
  fills them in afterwards;
- the editor offers a closed list instead of free text: no typo-regions, and
  renaming a zone is one edit in one file;
- old content still loads — a project without `zones` has one implicit zone and
  every map is in it.

Negative:
- a map file is no longer self-describing: its zone resolves only next to its
  project, which is a second cross-file reference to keep valid (doors were the
  first);
- the default being the *first* declared zone makes list order meaningful, so
  reordering `zones` moves every map that names none. The editor always writes
  the default first and materialises it on export, which keeps the ordering an
  internal detail rather than something an author must remember;
- simulating several maps per tick will cost more than simulating one, and a
  zone is the granularity at which that cost is paid — an author who puts forty
  maps in one zone pays for forty.

## Rule

Every map belongs to exactly one zone: resolve it through the project rather
than reading `WorldDefinition.zone` directly, and never reintroduce an "unzoned"
state.

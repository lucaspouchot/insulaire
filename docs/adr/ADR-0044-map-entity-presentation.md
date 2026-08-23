# ADR-0044 — Scale and Move Map Entities in Presentation Space

## Status
Accepted

## Context

An authored character canvas and a map tile do not share a useful pixel scale.
The shipped human is 128 pixels tall; drawing those pixels as 128 map units
makes the figure about four isometric tiles tall. The desired default is about
two tiles, and different maps must be able to choose another proportion.

This conflicts with the host rule in
`docs/adr/ADR-0029-characters-are-composed-sprites.md`: it requires every host
to use a whole-number character zoom. That rule keeps authored layer edges
exact, but it cannot make a 128-pixel canvas fit into sixty projected map
pixels. Letting each character carry an arbitrary map scale was rejected: the
canvas resolution already expresses that a 32-pixel creature is smaller than a
128-pixel human, and per-character scale would create a second competing size.

Movement had the same presentation leak. A command returns the authoritative
post-tick snapshot, so drawing that snapshot immediately teleports the player
and monsters to their destination before any walk cycle can be seen. Delaying
the snapshot was rejected because Angular must not own a shadow game state.

## Decision

A world may author `characterHeightTiles`, defaulting to `2`. It means: a
character canvas 128 pixels tall spans that many projected tile-face heights.
Every other canvas scales proportionally, so a 32-pixel creature is one quarter
as tall and a 256-pixel creature twice as tall. The renderer derives the screen
scale from the map's hex layout and projection; Rust transports and validates
the number but no simulation rule reads it.

Character layers and animation offsets remain whole authored pixels. The map
host alone may apply one fractional outer transform to the resolved character
as it places that complete canvas in the world. Editor and character-creation
previews keep the whole-number zoom decided by ADR-0029.

An accepted `entityMoved` event starts a presentation transition from `from` to
`to` for every entity kind, including monsters. `GameSnapshot` immediately
remains the authoritative destination; the render model carries only the
event's origin and a linear progress value. The renderer interpolates the two
projected ground points, including their authored elevations. A player's walk
cycle and its glide share the authored animation duration; an entity without a
movement animation uses a short presentation default. Another command waits
until the current transition finishes, so successive authoritative moves never
jump between two half-finished visual paths.

Map changes through links clear these transitions. Arrival on another authored
world is a map transfer, not a one-hex movement to interpolate across unrelated
coordinate spaces.

## Consequences

Positive:
- a 128-pixel human reads at the intended two-tile default on both projections;
- one map setting retunes the whole cast while character canvas sizes preserve
  relative creature scale;
- players and monsters visibly travel along every accepted move instead of
  appearing at its end;
- animation and interpolation remain presentation-only, so transcripts, saves
  and deterministic ticks are unchanged.

Negative:
- map characters may be fractionally resampled and therefore less crisp than
  their whole-number editor previews;
- commands are briefly unavailable while a transition is being presented;
- row-based isometric occlusion changes depth band midway through a diagonal
  move rather than continuously, because terrain is still batched by row.

## Rule

Map entity scale and motion are authored or derived presentation; the snapshot
always keeps the authoritative cell and no interpolation state enters Rust
`GameState`.

# ADR-0002 — Worlds Are Authored, Versioned, Data-Driven Content

## Status
Accepted

## Context

The world of this game is designed, not generated: its maps, locations,
important entities and scenario beats are decisions an author makes and revises.
Procedural generation would make the world a function of a seed, which is the
opposite of what is wanted — and it would make "the map changed" an
unreproducible event rather than a diff someone can read.

That settles what the world *is*. It leaves how it is stored. Content that tools
must edit and Git must version has to be inspectable and diffable; content the
runtime must load has to be identifiable and checkable. A format that satisfies
the first and not the second produces files nobody can validate, and one that
satisfies the second and not the first produces a project nobody can review.

## Decision

**The map is explicit, authored content.** Procedural terrain generation is not
a runtime responsibility. A seed may exist for simulation RNG, but it never
determines world geography.

**Content definitions are versioned files with stable ids.** Every content file
carries an `id` and a `schemaVersion`. Ids are what other files reference, so
renaming a file or reordering a list never breaks a reference.

**JSON is the format.** It is easy to inspect, diff and debug, which is what
authoring and review need. Large or performance-sensitive data may later move to
a binary representation without changing the conceptual model — what crosses the
engine boundary is already packed buffers rather than JSON (ADR-0010).

**The engine loads a `WorldDefinition`**, and refuses one it cannot validate
(ADR-0012).

## Consequences

Positive:
- worlds are saved, versioned with Git, edited visually, validated
  automatically and distributed as content;
- a change to the world is a reviewable diff, not a different seed;
- a schema version makes a format change explicit rather than silent.

Negative:
- a schema change is a real event: it bumps a version, updates the format
  document, and moves every file and caller with it;
- JSON is verbose, and a large map's file is large;
- authoring tooling is now on the critical path — content nobody can edit is
  content nobody will write.

## Rule

The world is authored. No runtime code may generate terrain, and no content file
may depend on a seed for its geography. Every content file carries an `id` and a
`schemaVersion`, and other files reference it by that id.

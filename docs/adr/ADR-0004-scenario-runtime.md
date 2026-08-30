# ADR-0004 — Make Scenario Progression Data-Driven

## Status
Accepted

## Context

The world carries an authored scenario: acts, objectives, events, countdowns and
scripted moments. Writing those into Rust would put the plot inside the engine,
which is the failure `CLAUDE.md` names outright — an engine full of
`if scenario == "chapter_two"` cannot host a second game and cannot be reasoned
about as rules.

The opposite extreme is worse in a different way. An unrestricted scripting
language would let content do anything, which makes content unreviewable,
unvalidatable and impossible to run deterministically — and it is an explicit
non-goal.

What is wanted is between the two: content that *declares* conditions and
consequences from a vocabulary the engine implements, so an author composes
behaviour without inventing it.

## Decision

**Scenario progression is a data-driven state machine.** Its concepts are
`Act`, `Objective`, `Flag`, `Timer`, `Trigger`, `Event` and `Consequence`.

```text
Trigger:
    tick >= 500
    AND flag "ritual_started" == true

=> Event:
    "ritual_complete"

=> Consequences:
    spawn boss
    set flag "boss_awake"
    advance act
    start event "guardian_arrives"
```

**The engine is a controlled interpreter, never an author.** It implements the
condition and consequence vocabulary and evaluates it at phase 5 of the tick
(ADR-0003). Scenario-specific rules are not hard-coded into Rust, and the engine
contains no branch on the name of a flag, an act or an objective.

**A scenario names things other content owns**: a map, a decoration placement's
id (ADR-0035), an object id (ADR-0036). Those ids are the seam through which a
plot reaches the world without the world knowing about the plot.

**The vocabulary grows deliberately.** A consequence the engine cannot perform is
a code change and an ADR, which is the price of not having a scripting language.

## Consequences

Positive:
- one engine can host more than one game, because none of this game is in it;
- a scenario is content: diffable, versionable, validatable and editable;
- evaluation happens at a named tick phase, so scenario progression is
  reproducible like everything else;
- authored content already has somewhere to point before the runtime exists —
  ids on placements and objects were chosen for this.

Negative:
- **none of this is implemented.** The concepts are decided and no runtime
  evaluates them, so every "the scenario will decide" elsewhere in these ADRs is
  a promise against this one;
- the vocabulary is a bottleneck by design: anything an author wants that the
  engine cannot express requires a code change, and judging where that line sits
  is a recurring cost;
- a declarative state machine is harder to debug than a script, because the
  behaviour is spread across triggers rather than written in order;
- validation has to cover cross-references a single file cannot resolve, which is
  the same whole-project pass that doors and zones already need.

## Rule

The engine may not contain a scenario-specific branch. A scenario declares
conditions and consequences from the engine's vocabulary; anything it cannot say
is a gap in that vocabulary, filled by an ADR, never by an `if` in Rust.

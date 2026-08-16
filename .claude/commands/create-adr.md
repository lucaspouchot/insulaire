---
description: "Create a new Architecture Decision Record (ADR) for the Hex Engine project."
---

Create an Architecture Decision Record in `docs/adr/`.

> **Do not use the `create-architectural-decision-record` skill.** It is a
> vendored generic template whose format — YAML front matter, `POS-001` /
> `NEG-001` coded bullets, a dedicated "Alternatives Considered" section — does
> not match the ADRs already in this repository. Consistency with the existing
> set wins. The format below is this project's.

## Before writing

`CLAUDE.md` makes ADRs the only way an architectural decision changes. If the
new decision touches an existing one:

1. read the ADRs it affects;
2. name the conflict explicitly in **Context** — do not leave it implied;
3. supersede the old decision rather than quietly contradicting it;
4. never leave two ADRs asserting opposite rules.

An ADR records a decision that is expensive to reverse. A choice that is local
to one module and cheap to change is a code comment, not an ADR.

## Inputs

Gather these from the user, and ask explicitly for anything missing:

- **Decision Title** — short and declarative, phrased as the decision itself
  ("Use Deterministic RNG", "Render the World Through Canvas/WebGL"), not as a
  topic ("RNG").
- **Context** — the forces: constraints, requirements, measurements, and the
  failure modes that were easy to fall into. Rejected alternatives belong here
  or in Decision, as prose with the reason — the existing ADRs do not use a
  separate section for them.
- **Decision** — what was chosen, stated in the present tense as something the
  project now does.
- **Consequences** — both directions. An ADR with no negative consequences has
  not been thought through.
- **Rule** *(optional)* — a single enforceable sentence a reviewer can apply.
  Add one when the decision implies an ongoing constraint on contributors.
- **Supersedes** *(optional)* — the ADR number this replaces.

There is no stakeholders or authors field; the format has no place for one.

## Process

1. `ls docs/adr/` to find the next free number `NNNN`.
2. Write `docs/adr/ADR-NNNN-<title-slug>.md` using the template below.
3. Append a numbered entry to the **Architecture decisions** list at the bottom
   of the root `README.md` — that list is the index, and it is the only one.
   Mark decisions not yet implemented as `*(not implemented yet)*`.
4. If the ADR supersedes an earlier one, edit the old file's `## Status` to
   `Superseded by ADR-NNNN` and add one line saying what replaced it. Leave the
   rest of the old ADR intact: superseded decisions stay readable.
5. If code depends on the decision, cite it from the doc comments as
   `docs/adr/ADR-NNNN-<title-slug>.md` so the reference stays greppable.

## Naming

```text
docs/adr/ADR-NNNN-<title-slug>.md
```

- `ADR` uppercase, `NNNN` zero-padded to four digits.
- `<title-slug>` lowercase, hyphen-separated, short — the subject, not the whole
  title: `ADR-0014-hex-coordinate-model.md`, not
  `ADR-0014-use-odd-r-offset-coordinates-for-content.md`.

## Template

```md
# ADR-NNNN — [Decision Title]

## Status
Accepted

## Context

[The forces that made this decision necessary: constraints, requirements,
measurements, and the failure modes that were easy to fall into. Name the
alternatives that were rejected and why.]

## Decision

[What the project now does, in the present tense. Tables, short code blocks and
`text` diagrams are welcome when they carry the decision more precisely than
prose.]

## Consequences

Positive:
- [what this buys]

Negative:
- [the trade-off, the debt, the risk — and, where it applies, what would have to
  be true for it to matter, and how local the fix would be]

## Rule

[Optional. One sentence a reviewer can enforce.]
```

## House style

- Title line: `# ADR-NNNN — [Title]`, with an em dash.
- `## Status` values in use: `Accepted`, `Accepted with caveat`. Also allowed:
  `Proposed`, `Superseded by ADR-NNNN`, `Deprecated`.
- The four sections `Status`, `Context`, `Decision`, `Consequences` are
  mandatory and always in that order. `Rule` is optional and comes last. Add a
  further section only when the decision genuinely needs it — ADR-0012's
  `## Important caveat` is the sole precedent.
- Keep it to roughly a page. Existing ADRs run 20–60 lines; they state the
  decision and its cost, not a design document.
- Write for someone joining in a year who is about to contradict the decision by
  accident.

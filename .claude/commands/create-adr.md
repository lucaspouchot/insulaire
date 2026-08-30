---
description: "Create or amend an Architecture Decision Record (ADR) for the Insulaire project."
---

Record an architectural decision in `docs/adr/`.

> **Do not use the `create-architectural-decision-record` skill.** It is a
> vendored generic template whose format — YAML front matter, `POS-001` /
> `NEG-001` coded bullets, a dedicated "Alternatives Considered" section — does
> not match the ADRs in this repository. The format below is this project's.

## First decide whether this is a new ADR at all

**Most decisions that touch an existing one are an edit to that ADR, not a new
file.** This is the most important rule on this page, and ignoring it is what
produced a corpus of fifty-one ADRs where six documents had to be read in order
to learn how a character animates.

Ask which of these it is:

- **It changes what an existing decision says.** Edit that ADR. Rewrite the
  affected paragraphs in the present tense so the file states what the project
  does *now*. Do not add a note saying what it used to say, do not append an
  amendment paragraph, and do not open a new file. Git holds the history.
- **It completes an existing decision** — the field it left for later, the
  instance for its kind, the tie it left unbroken. Edit that ADR.
- **It is a genuinely new decision area** that no existing ADR is about. Write a
  new one, with the next free number.

Two ADRs may never assert opposite rules, and no ADR may describe a mechanism
the code no longer has.

An ADR records a decision that is expensive to reverse. A choice local to one
module and cheap to change is a code comment, not an ADR — and a layout finding,
a CSS workaround or a debugging note is always a code comment.

## Before writing

`CLAUDE.md` makes ADRs the only way an architectural decision changes. If the new
decision touches an existing one, read the ADRs it affects first, and name the
conflict explicitly rather than leaving it implied.

## Inputs

Gather these, and ask explicitly for anything missing:

- **Decision Title** — short and declarative, phrased as the decision itself
  ("Use Deterministic RNG", "Render the World to a Canvas"), not as a topic
  ("RNG").
- **Context** — the forces: constraints, requirements, measurements, and the
  failure modes that were easy to fall into. Rejected alternatives belong here as
  prose with the reason. There is no separate section for them.
- **Decision** — what was chosen, in the present tense, as something the project
  now does.
- **Consequences** — both directions, as `Positive:` and `Negative:` lists. An
  ADR with no negative consequences has not been thought through.
- **Rule** *(optional)* — a single enforceable sentence a reviewer can apply.

There is no stakeholders or authors field; the format has no place for one.

## Process

### Amending an existing ADR

1. Edit the file in place so it reads as one current decision.
2. Leave `## Status` as `Accepted`. A decision that changed is still accepted —
   it is simply a different decision now.
3. Bump any schema version the change touches, and update
   `docs/content-format.md`, `docs/data-model.md` and `docs/wasm-api.md` as
   `.claude/rules/specs.md` requires.
4. Update the ADR's entry in the README index if its title changed.

### Writing a new ADR

1. `ls docs/adr/` and take the next number after the highest. Numbering is
   contiguous and **a number is never reused** once committed. If folding leaves
   a gap, close it by renumbering the whole set in one change — never by
   dropping a new decision into the hole.
2. Write `docs/adr/ADR-NNNN-<title-slug>.md` from the template below.
3. Add a line to the **Architecture decisions** list in the root `README.md` —
   that list is the index, and it is the only one. Mark decisions not yet
   implemented as `*(not implemented yet)*`.
4. If code depends on the decision, cite it from the doc comments as
   `docs/adr/ADR-NNNN-<title-slug>.md` so the reference stays greppable.

### Folding one ADR into another

Only when two files genuinely describe one decision:

1. Rewrite the survivor so it states the whole decision in the present tense.
2. Delete the other file. Do not leave a stub.
3. Rewrite every citation of the deleted number **and** its full path — they
   appear in Rust doc comments, TypeScript comments, `scripts/`, `docs/` and the
   README — to point at the survivor, and collapse any duplicate reference the
   rewrite creates.
4. Verify that no `ADR-NNNN` anywhere in the repository fails to resolve.
5. Choose the survivor's number to be whichever of the two is cited more, so the
   rewrite is as small as possible.

## Naming

```text
docs/adr/ADR-NNNN-<title-slug>.md
```

- `ADR` uppercase, `NNNN` zero-padded to four digits.
- `<title-slug>` lowercase, hyphen-separated, short — the subject, not the whole
  title.
- **A slug never changes once it is committed**, because it is cited by path
  across the codebase. A title may be rewritten freely; the filename may not.

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

[What the project does, in the present tense. Tables, short code blocks and
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
- **`## Status` is a value, never a narrative.** The permitted values are
  `Accepted`, `Accepted with caveat`, `Proposed`, `Deprecated`, and
  `Superseded by ADR-NNNN`. A Status that explains what changed, what still
  stands or what a later ADR amended is the defect this format exists to
  prevent — put the current decision in the Decision section instead.
- `Status`, `Context`, `Decision`, `Consequences` are mandatory and always in
  that order; `Rule` is optional and comes last. **Add no other section.**
- **Write in the present tense throughout.** An ADR describes what the project
  does, not what it used to do or what a later change did to it. Never leave a
  parenthetical amendment inside a paragraph.
- Length: a single decision runs 40–90 lines. One covering a whole area — the
  character model, tile art, the asset editor — may reach 200. Past that, either
  the decision is really two, or the document has absorbed detail that belongs in
  `docs/content-format.md` or in a code comment. Length is a smell, not a limit:
  never cut a decision to hit a number.
- Write for someone joining in a year who is about to contradict the decision by
  accident.

---
description: "Create a new Architecture Decision Record (ADR) for the Ternat project."
---

Create an Architecture Decision Record (ADR) for the Ternat project.

Use the `create-architectural-decision-record` skill (`.claude/skills/create-architectural-decision-record/SKILL.md`) for the ADR format, template, and writing rules.

## Project-Specific Inputs

Gather the following from the user before proceeding. If any are missing, ask for them explicitly:

- **Decision Title**: A short, concise name for the decision (e.g. "Backend Stack Selection")
- **Context**: Why was this decision needed? Include relevant constraints, benchmark findings, requirements, and environmental factors.
- **Decision**: What was decided and why? Be specific about the chosen option and the rationale.
- **Alternatives Considered**: What other options were evaluated? Why was each rejected?
- **Stakeholders / Authors**: Who was involved in or should review this decision?

## Project-Specific Process

1. List all existing files in `docs/adr/` to determine the next sequential ADR number (`NNNN`).
2. Generate the ADR file using the skill's template and the naming convention below.
3. Save the file to `docs/adr/adr-NNNN-<title-slug>.md`.
4. Update the index table in `docs/adr/README.md` to add a row for the new ADR.

## Naming Convention

```
docs/adr/adr-NNNN-<title-slug>.md
```

- `NNNN` — next available zero-padded 4-digit number (check existing files)
- `<title-slug>` — lowercase, hyphen-separated version of the decision title

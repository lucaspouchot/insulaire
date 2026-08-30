# Codex guidance — Insulaire

`CLAUDE.md` is the canonical project brief for both coding agents. Read it in
full before starting work in this repository and follow all of its project
rules as if they were written here. Do not create a second, competing project
brief in this file.

## Shared agent context

- The reusable workflows in `.claude/skills/` are the source of truth. Codex
  must select from the index below whenever a request matches, then read the
  referenced `SKILL.md` in full before acting. This is a repository-scoped
  bridge for environments where `.agents/skills` is unavailable.
  Where `.agents` is writable, run `node scripts/setup-codex-skills.mjs` once
  after cloning to enable Codex's native skill discovery as well.
- `commit-and-push` — for a request to commit and/or push: read
  `.claude/skills/commit-and-push/SKILL.md`. It commits, bumps and pushes; it
  never runs a test or a gate.
- `generate-images-with-pixellab` — for every request to generate, draw,
  illustrate or edit an image: read
  `.claude/skills/generate-images-with-pixellab/SKILL.md`. PixelLab is required
  by the project; do not substitute another image generator or placeholder.
- `verify-no-regression` — after any change when verification is requested or
  the work is ready to be considered complete: read
  `.claude/skills/verify-no-regression/SKILL.md`.
- `create-architectural-decision-record` — only when a generic ADR is
  explicitly requested: read
  `.claude/skills/create-architectural-decision-record/SKILL.md`. For this
  repository, `create-adr` below takes precedence.
- For a Rust change, read and follow `.claude/rules/rust.md`.
- For a change to Rust behaviour, TypeScript engine behaviour, or content
  JSON, read and follow `.claude/rules/specs.md` before editing. It determines
  the contract documents and tests the change owes.
- For an architectural decision or a request to create an ADR, read and follow
  `.claude/commands/create-adr.md` before gathering inputs or editing. Its
  project-native format overrides the vendored generic ADR skill.

## Keeping the bridge intact

Keep `.claude/skills/` as the single source of truth. When adding, renaming or
removing a Claude skill, update the shared-agent skill index in this file in
the same change. `scripts/claude-skills-compat.test.mjs` protects that index.
When the environment permits a writable `.agents/skills`, expose the same
folders there as symbolic links rather than copies; Codex will then discover
their metadata automatically. `scripts/setup-codex-skills.mjs` performs that
safe, idempotent setup and refuses to overwrite an existing entry.

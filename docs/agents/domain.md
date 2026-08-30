# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

This is a single-context repo: one `CONTEXT.md` at the root, one `docs/adr/`.

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── ADR-0001-separation-ui-engine.md
│   ├── ADR-0002-rust-wasm.md
│   └── ADR-0050-an-object-icon-is-a-flipbook.md
├── apps/          ← web (Angular) + desktop (Tauri)
└── crates/        ← engine, simulation, wasm, world
```

ADRs are named `ADR-NNNN-kebab-title.md`, numbered sequentially from `0001`.

## Writing an ADR

Do not invent an ADR format. `.claude/commands/create-adr.md` is the authoritative one for this repo, and `CLAUDE.md` requires reading the relevant ADRs before changing an architectural decision. The generic ADR skill is superseded by it.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (renderer: Canvas/WebGL), but worth reopening because…_

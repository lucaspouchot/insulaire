---
description: 'Keep the functional specs in docs/spec/ in sync with behaviour changes'
paths:
  - "back/src/**/*.rs"
  - "front/src/app/**/*.ts"
---

# Functional Specs Stay in Sync

The functional specifications in `docs/spec/` (rules `ACC-`, `EVT-`, `REG-`, `ROO-`, `ROL-`, `NTF-`, `MOD-`, `FBK-`)
are the source of truth for what the webapp does.

- If your change alters **user-visible behaviour** (a rule, a flow, a permission, a
  status, a validation), update the matching spec file in `docs/spec/` **in the same
  change**, following the `maintain-project-specs` skill
  (`.claude/skills/maintain-project-specs/SKILL.md`): rewrite changed rules in place,
  append new IDs for new behaviour, never renumber.
- If the code you are changing contradicts a spec rule, flag it — one of the two has a
  bug; do not silently diverge.
- Pure refactorings, styling and technical changes need no spec update.

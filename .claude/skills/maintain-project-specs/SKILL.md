---
description: Maintain the functional specifications in docs/spec/ — format, rule numbering, and when to update them.
name: maintain-project-specs
---
# Maintain Project Specs

The functional specifications in `docs/spec/` are the source of truth for what the
Ternat webapp does. This skill defines their format and the procedure to keep them in
sync with the code.

## Layout

One file per domain, indexed in `docs/spec/README.md`:

| File | Prefix | Scope |
|------|--------|-------|
| `accounts.md` | `ACC-` | Signup, login, roles, validation, messages, profile |
| `events.md` | `EVT-` | Event lifecycle, visibility, creation, edition, deletion |
| `registrations.md` | `REG-` | Registrations, stays, guests, validation queue |
| `rooms.md` | `ROO-` | Floor plan, bedrooms, per-day assignments |
| `roles.md` | `ROL-` | Volunteer role catalog, per-event role assignments and overrides |
| `notifications.md` | `NTF-` | Email / Discord DM notifications, preferences, debounce |
| `modules.md` | `MOD-` | Optional feature modules: which parts of the app the community uses |
| `feedback.md` | `FBK-` | Feedback on actions: toasts, coalescing, inline messages |

## Rule format

- Every requirement is a bullet `- **XXX-NNN**: <statement>` — one testable behaviour per rule, written for the user's point of view (roles, screens, outcomes), not implementation details.
- IDs are grouped in decades by theme (`REG-010`, `REG-011`, ... then `REG-020` for the next theme) so new rules can be appended inside their theme.
- Each file starts with an **Overview** paragraph and may use small tables for enumerations (statuses, roles, zones).

## Updating the specs

Whenever a change alters user-visible behaviour:

1. Find the impacted rules (`grep` the prefix or keywords in `docs/spec/`).
2. **Changed behaviour** → rewrite the rule's text in place, keeping its ID.
3. **New behaviour** → append a new rule with the next free ID in the matching theme; create a new theme section (next decade) or a new file (new prefix + README index row) if none fits.
4. **Removed behaviour** → keep the ID, replace the text with `(removed)` and a short reason.
5. **Never renumber or reuse an ID** — history and reviews rely on them being stable.

The spec update belongs in the same change as the code — a behaviour change without its
spec update is incomplete.

## Creating a new spec file

1. Pick a short uppercase prefix (3-4 letters) not already used.
2. Follow the format above (Overview, tables, coded rules).
3. Add the file to the index table in `docs/spec/README.md`.

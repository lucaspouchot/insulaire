# ADR-0009 — Require No Backend; Distribute as Static Files

## Status
Accepted

## Context

The game should not require a backend or a native installation to play. A server
in the delivery path means hosting, an API to version, a failure mode between the
player and their own save, and a project that cannot simply be handed to someone.

The risk in going that far was known and written down when this was decided:
opening `index.html` directly through `file://` is subject to browser security
restrictions, especially around module and WASM loading, and that had to be
tested early against real browsers rather than assumed.

It was tested, and it failed exactly as predicted. Each `file:` URL is an opaque
origin, so the module imports, the WASM glue and the content fetches were all
blocked and a player who unzipped a delivery and double-clicked got a black
screen. That is a fact about `file://`, not about the architecture: served over
HTTP from any static host, the same bundle works. ADR-0017 is what the client
delivery became instead — a desktop executable hosting the same bundle — and it
changes the *packaging*, not this invariant.

## Decision

**The runtime has no dependency on an application server.** The product is a
static bundle: HTML, JS, CSS, WASM, assets and authored content. A normal static
web host is sufficient, and so is a webview reading the same files from disk.

**Nothing in the game may acquire a runtime dependency on a server.** The
authoring content server (ADR-0019) is a development tool, guarded out of the
client build; it is not an exception to this rule, it is outside what a player
receives.

**`file://` is not a supported entry point.** What remains of that discovery is
the inline notice in `index.html`, which catches a developer opening a `dist/`
build by hand.

## Consequences

Positive:
- a delivery is a folder, and playing needs nothing installed and nothing
  reachable over a network;
- the same bundle serves development, the editor, a static host and the desktop
  shell, so a bug can never be "only in the delivery";
- there is no server-side state to migrate, secure or keep running.

Negative:
- anything genuinely needing a server — accounts, cloud saves, multiplayer —
  is not an incremental addition but a change to this decision;
- saves are local to a machine and a browser profile (ADR-0007);
- `file://` not working means a static bundle alone is not something a
  non-technical player can open, which is the whole reason ADR-0017 exists.

## Rule

No build of the game may require an application server to start, load content or
play. A tool that runs one is a development tool and must be absent from the
client build's import graph.

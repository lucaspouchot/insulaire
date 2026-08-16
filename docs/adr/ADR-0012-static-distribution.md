# ADR-0012 — Distribute as a Static Web Application

## Status
Accepted with caveat. Amended by ADR-0020: the caveat below came true, and the
**client** delivery is now a desktop executable. The static bundle remains what
development, the editor and any web hosting use, and the architectural
invariant — no backend, no application server — is unchanged.

## Context

The game should not require a backend or native installation.

## Decision

The target product is a static bundle containing:
- HTML
- JS
- CSS
- WASM
- assets
- authored content

The runtime has no dependency on an application server.

## Important caveat

Opening `index.html` directly through `file://` is subject to browser security restrictions, especially around module and WASM loading.

This constraint must be tested early with the actual target browsers.

The architecture must not depend on a backend: a normal static web host is sufficient for standard distribution.

## Consequences

If `file://` is unreliable on a target browser, the same engine and application can be served from static hosting without changing the core architecture.

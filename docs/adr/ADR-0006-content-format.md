# ADR-0006 — Use Versioned Data-Driven Content

## Status
Accepted

## Context

Worlds and scenarios must be editable by tools and versionable with Git.

## Decision

Content definitions are versioned files with stable IDs and schema versions.

JSON is recommended for the first implementation because it is easy to inspect, diff and debug.

Large or performance-sensitive data may later use a binary representation without changing the conceptual model.

Every content file has:
- `id`
- `schemaVersion`

## Consequences

Content migrations must be explicit.

The editor must validate broken references before export.

# ADR-0006: UUIDv7 identifiers and SHA-256 artifacts

- **Status:** PROVISIONAL
- **Date:** 2025-07-11
- **Decision owner:** protocol owner
- **Supersedes:** none
- **Related:** SPEC §28.1, §29.3

## Context

Terminus needs stable, sortable, collision-resistant identifiers for every domain entity (workspaces, sessions, threads, tasks, turns, episodes, attempts, tool calls, jobs, agents, memory claims, capabilities, events) and content-addressed identifiers for every artifact (tool output, diffs, traces, evidence, full provider responses).

Random UUIDv4 loses time-ordering, which complicates cursor-based pagination and event-stream reconstruction. Sequential integers lose global uniqueness across workspaces/tenants. SHA-1 is broken. Blake3 is fast but less universally supported than SHA-256.

## Decision

Adopt **UUIDv7 for entity identifiers** and **SHA-256 for content addressing** per SPEC §28.1:

- Public domain identifiers MUST use UUIDv7 encoded as lowercase canonical strings. UUIDv7 is time-ordered (millisecond prefix) + random, so it sorts chronologically and is globally unique without coordination.
- Content identities MUST use `sha256:<hex>`.
- Artifact URIs MUST use `artifact://sha256/<hex>`.
- Internal resource URIs MAY use `workspace://`, `session://`, `task://`, `turn://`, `job://`, `agent://`, `memory://`, `tool://`, `rule://`, `verification://`.
- Timestamps MUST be RFC 3339 UTC with microsecond precision where available.
- Monetary values MUST be integer micros of the configured billing currency; floating-point money is forbidden.
- Token counts and byte counts MUST be unsigned 64-bit integers at storage boundaries.

Status is PROVISIONAL because the exact UUID library and SHA-256 implementation choices are subject to a replacement gate (e.g., if a future Terminus deployment needs UUIDv8 for additional entropy, this ADR is amended).

## Alternatives

- **UUIDv4.** Rejected: no time ordering; complicates event-stream reconstruction and cursor pagination.
- **Sequential integers.** Rejected: not globally unique; leaks count information; coordination cost across workspaces.
- **ULID.** Rejected: not a standard; UUIDv7 covers the same ground.
- **SHA-1.** Rejected: broken (SHAttered).
- **Blake3.** Rejected: less universal tooling; SHA-256 is sufficient for Terminus's content-addressing needs and matches the SPEC §28.1 requirement.

## Consequences

- The `uuid` Rust crate (v7 feature) and the `crypto.randomUUID()` TS API (with v7 polyfill) are required.
- All entity tables use `TEXT PRIMARY KEY` for UUIDv7; all artifact references use `sha256:<hex>`.
- Event streams are naturally ordered by `(aggregate_id, sequence)` where `aggregate_id` is UUIDv7.
- Sortable IDs simplify pagination, debugging, and log correlation.

## Security Impact

Low. UUIDv7's millisecond timestamp reveals coarse creation time, which is acceptable. SHA-256 is cryptographically strong for content addressing. No secret values are encoded in identifiers.

## Evaluation Plan

- Property tests verify UUIDv7 generation is monotonic within a millisecond and unique across 1M generations.
- Artifact hash stability tests verify the same content produces the same hash across compression/encoding.
- Migration tests verify imported legacy v4 IDs, if any, are mapped to v7 with a one-time migration.

## Migration

Imported legacy entities may use UUIDv4; they are migrated to UUIDv7 during M2 (SPEC §48.5). The migration is one-way with a recorded mapping table.

## Rollback

If UUIDv7 is found unsuitable, amend this ADR to UUIDv8 or another sortable scheme. Existing UUIDv7 values remain valid (they are still valid UUIDs); new identifiers use the new scheme. Do not silently mix schemes.

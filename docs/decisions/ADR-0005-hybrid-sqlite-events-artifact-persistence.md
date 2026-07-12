# ADR-0005: Hybrid SQLite/events/artifact persistence

- **Status:** ADOPTED
- **Date:** 2025-07-11
- **Decision owner:** persistence owner
- **Supersedes:** none
- **Related:** SPEC §7.3, §29, Appendix C

## Context

Forge needs durable storage for: workspace/session/thread/task/turn state, semantic events, content-addressed artifacts (tool output, diffs, traces, evidence), Git state, FTS5/full-text search, and optional vector indexes. A single store cannot serve all of these well: relational state needs transactions; events need append-only semantics with cursors; artifacts need content addressing and GC; FTS5 needs SQLite's extension; vectors need a separate index.

Pure event sourcing would force a rebuild on every restart and complicate ad-hoc queries. Pure relational would lose the audit/event-stream properties. Pure object storage would lose transactions.

## Decision

Adopt a **hybrid persistence model** per SPEC §7.3 and §29:

1. **SQLite/WAL** for relational state (workspaces, sessions, threads, tasks, turns, contracts, scope ledger, provider attempts, context epochs/manifests/fragments, artifact links, tool calls, policy decisions, approvals, side effects, jobs, agents, delegations, verification plans/nodes/edges/results, memory claims/relations, capabilities/activations, idempotency records, leases, event stream cursors). STRICT tables, foreign keys, schema migrations under `migrations/sqlite/`.
2. **Semantic event log** (SQLite table + JSONL export) for the append-only event stream. Event types from `schemas/events/catalog.yaml` (31 types). SSE consumers read via opaque cursors.
3. **Content-addressed artifact store** (`artifact://sha256/<hex>`) for tool output, diffs, traces, evidence, full provider responses. Layout per SPEC §29.3. Atomic ingest; GC with dry-run.
4. **Git/worktrees** for repository state. Protected operations through `forge-git` crate.
5. **FTS5** (SQLite extension) for lexical search. Optional vector index behind a flag (ADR-0028 OPEN).

PRAGMAs: `journal_mode=WAL`, `foreign_keys=ON`, `synchronous=NORMAL`, `busy_timeout=5000`.

The schema is in `migrations/sqlite/0001_initial.sql` and `prisma/schema.prisma`; migrations are the executable source of truth (SPEC §29, Appendix C).

## Alternatives

- **Pure event sourcing.** Rejected: rebuild cost on restart; harder ad-hoc queries; complicates state-machine guards.
- **PostgreSQL.** Rejected: violates local-first; requires a daemon; worse offline story. May revisit for remote multi-tenant (ADR-0030 OPEN).
- **All artifact (content-addressed) with no SQL.** Rejected: loses transactions; bad for state machines.
- **DuckDB for analytics.** Rejected for primary store; the Python eval lab uses DuckDB for analytics on Parquet exports.

## Consequences

- SQLite is the only production database dependency. Migrations are forward-tested with rollback strategy documented (SPEC §46.17).
- The Python eval lab consumes Parquet/JSONL exports — it does not query SQLite directly.
- Artifact GC must preserve references from active sessions/tasks.
- FTS5 is bundled with SQLite; vector indexes are optional.
- Backups are SQLite + artifact directory + Git (SPEC §29.6).

## Security Impact

Medium. SQLite STRICT tables enforce column types. Foreign keys prevent orphaned records. The semantic event log provides audit. Artifact content addressing provides integrity. Secret values MUST NOT be stored in SQLite or artifacts — only capability handles and redacted metadata (SPEC §13.6, §36.13).

## Evaluation Plan

- Migration tests run forward and rollback (SPEC §46.18).
- Recovery tests inject failures at every durable boundary (SPEC §46.9).
- Artifact corruption tests verify integrity.
- Backup/restore round-trip tests (SPEC §50.2).

## Migration

The initial schema is `migrations/sqlite/0001_initial.sql`. Future schema changes are numbered migrations with checksums in `schema_migrations`. The Prisma schema mirrors the SQL for client generation; SQL is the source of truth.

## Rollback

Each migration has a documented rollback. The startup recovery report (SPEC §48.5) identifies non-terminal records on restart. If a migration cannot be rolled back, the prior version's binary remains runnable until the data is exported and re-imported.

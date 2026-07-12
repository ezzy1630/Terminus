# Data plane

This document is the deep dive for the data plane (SPEC §7.3, §29, Appendix C). The data plane is governed by ADR-0005 (hybrid SQLite/events/artifact persistence) and ADR-0006 (UUIDv7 + SHA-256).

## Storage responsibilities (SPEC §29.1)

The data plane stores:

- **Relational state** — workspaces, sessions, threads, tasks, turns, episodes, provider attempts, tool calls, policy decisions, approvals, side effects, jobs, agents, delegations, verification plans/nodes/edges/results, memory claims/relations, capabilities/activations, idempotency records, leases, event stream cursors.
- **Semantic event log** — append-only event stream with opaque cursors.
- **Content-addressed artifacts** — tool output, diffs, traces, evidence, full provider responses.
- **Git state** — repository, worktrees, commits, branches.
- **FTS5 index** — lexical search index (SQLite extension).
- **Optional vector index** — semantic search (OPEN, ADR-0028).

## SQLite (SPEC §29.2, ADR-0005)

- **Engine:** SQLite with WAL mode.
- **PRAGMAs:** `journal_mode=WAL`, `foreign_keys=ON`, `synchronous=NORMAL`, `busy_timeout=5000`.
- **Tables:** STRICT tables with explicit column types.
- **Foreign keys:** enforced.
- **Schema migrations:** under `migrations/sqlite/`, numbered, checksummed, forward-tested with rollback strategy.
- **Schema snapshot:** ER diagram generated from migrations.

The initial schema is `migrations/sqlite/0001_initial.sql`. The Prisma schema (`prisma/schema.prisma`) mirrors the SQL for client generation; SQL is the source of truth.

## Schema (Appendix C)

Key tables (full list in Appendix C and `prisma/schema.prisma`):

- `schema_migrations` — version, name, checksum_sha256, applied_at.
- `workspaces` — id, kind, root_uri, canonical_root, trust, repository_json, policy_profile_id, timestamps.
- `sessions` — id, workspace_id, owner_principal, title, status, default_model_profile, default_permission_profile, active_thread_id, metadata_json, timestamps.
- `threads` — id, session_id, parent_thread_id, forked_from_turn_id, status, active_context_epoch_id, head_turn_id, timestamps.
- `tasks` — id, session_id, thread_id, status, phase, active_contract_version, risk_class, verification_plan_id, budget_json, scope_digest, timestamps.
- `task_contract_versions` — task_id, version, objective, user_outcome, non_goals_json, constraints_json, assumptions_json, unknowns_json, allowed_scope_json, change_policy_json, content_hash, created_by, created_at.
- `turns`, `episodes`, `provider_attempts`, `tool_calls`, `policy_decisions`, `approvals`, `side_effects`, `jobs`, `agents`, `delegations`.
- `context_epochs`, `context_manifests`, `context_fragments` — context compiler state.
- `artifacts`, `artifact_links` — content-addressed store metadata.
- `verification_plans`, `verification_nodes`, `verification_edges`, `verification_results`, `completion_records`.
- `memory_claims`, `memory_relations`.
- `capabilities`, `capability_activations`.
- `idempotency_records`, `leases`.
- `semantic_events` — append-only event stream.
- `event_stream_cursors` — SSE cursor positions.

## Artifact store layout (SPEC §29.3)

```
<artifact-root>/
  sha256/
    <aa>/                          # First 2 hex chars (sharding)
      <bb>/                        # Next 2 hex chars
        <64-hex-chars>             # Full sha256
          content                  # Raw bytes
          metadata.json            # media_type, size_bytes, ingested_at, source
```

Artifact URIs: `artifact://sha256/<hex>`.

Atomic ingest: write to temp file, fsync, rename. GC with dry-run preserves references from active sessions/tasks.

## Artifact retention (SPEC §29.4)

- Default retention: artifacts referenced by active sessions/tasks are preserved.
- Unreferenced artifacts: eligible for GC after configurable TTL.
- Audit artifacts (policy decisions, approvals, security events): retained per organization policy (typically 90 days minimum).
- Evidence artifacts (verification results, completion records): retained for the task's lifetime + configurable retention.
- Provider-attempt artifacts (full requests/responses): retained per confidentiality policy.

## Checkpoints and recovery (SPEC §29.5)

- On restart, the startup recovery report identifies non-terminal records (running tasks, in-flight jobs, unknown-settlement effects).
- Job reconciliation: each `JobService.Get` returns the reconciled state.
- Patch journal replay: incomplete transactions are rolled back or completed.
- Unknown-settlement reconciliation: external effects with unknown state are reconciled before retry (SPEC §26.3 #9).

## Backups and export (SPEC §29.6)

- **Backup:** SQLite file + artifact directory + Git.
- **Export:** RunRecord JSONL + Parquet for analytics.
- **Round-trip:** backup → restore → verify integrity.

Backup/restore tests run in CI (SPEC §50.2).

## Semantic event log (SPEC §7.3, §45.5)

The event catalog (`schemas/events/catalog.yaml`) defines 31 event types:

- workspace: created, opened, closed.
- session: created, paused, resumed, archived.
- thread: created, forked.
- task: created, contract_updated, phase_changed, completed, failed, cancelled.
- turn: started, completed.
- context: epoch_changed, manifest_persisted.
- tool: started, completed, denied.
- policy: decision_rendered, approval_requested, approval_decided.
- secret: capability_issued, capability_used, capability_revoked, redaction_event.
- security: bypass_attempt, sandbox_escape_attempt, prompt_injection_detected.
- capability: activated, deactivated, descriptor_changed.
- memory: claim_created, claim_queried, claim_expired, claim_quarantined.

Each event has: type, version, aggregate, payload schema, PII classification, retention class. The generator produces: runtime validators, event type unions, JSON Schema, Markdown catalog, synthetic fixtures, migration compatibility tests (SPEC §45.5).

## Event stream and cursors (SPEC §7.3)

- SSE consumers read via opaque cursors.
- Cursors are monotonically increasing per aggregate.
- Resume: client sends last cursor; server replays from there.
- Duplicate detection: server-side by event sequence.

## FTS5 (SPEC §7.3)

- SQLite extension; bundled.
- Lexical search (BM25) with rank, snippets, facets, continuation.
- Indexes: file contents, symbol names, documentation.

## Optional vector index (ADR-0028 OPEN)

- Behind a flag (not default).
- Local embeddings (privacy-preserving) or provider embeddings (behind gate).
- Stored separately from SQLite (LanceDB/Qdrant/in-process HNSW).

## Git (SPEC §7.3, ADR-0013)

- `crates/terminus-git` provides protected worktree/commit/merge operations.
- Worktrees are isolated per writer (ADR-0020).
- Git hooks and filters from untrusted sources are disabled.
- `.git` is in the deny list of the default policy (`policies/sandbox/secure-local-default.yaml`).

## OpenTelemetry (SPEC §7.3, §47)

- Traces: task.run → turn.run → provider.attempt → tool.call → effect.execute.
- Metrics: see SPEC §47.3.
- Logs: structured, redactable (SPEC §44.6).
- Parquet analytics: RunRecords exported for the eval lab.

## Performance budgets (SPEC §47.6)

Initial performance budgets:

- Context compilation: < 200ms p99 for < 100k-token context.
- Tool call overhead: < 50ms p99 (excluding tool execution).
- Provider attempt record: < 10ms p99.
- Job start: < 100ms p99.
- Patch apply (small): < 50ms p99.

## Reliability objectives (SPEC §47.7)

- Task restart/resume success: > 99.9%.
- Patch journal recovery: 100% (no silent data loss).
- Artifact integrity: 100% (no corruption undetected).
- Event stream: at-least-once with idempotent consumers.

## Evaluation plan

- Migration tests: forward + rollback (SPEC §46.18).
- Recovery tests: fault injection at every durable boundary (SPEC §46.9).
- Artifact corruption tests (SPEC §50.2).
- Backup/restore round-trip tests (SPEC §50.2).
- Performance budget tests (SPEC §47.6).
- Reliability objective tests (SPEC §47.7).

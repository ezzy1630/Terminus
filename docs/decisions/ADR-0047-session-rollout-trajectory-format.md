# ADR-0047: Canonical session rollout trajectory format

- **Status:** ADOPTED
- **Date:** 2026-08-26
- **Decision owner:** data / telemetry owner
- **Supersedes:** none
- **Related:** SPEC §29, §32; ADR-0005; ADR-0009; ADR-0010

## Context

Exporting, resuming, forking, and analyzing agent session executions requires a canonical, portable trajectory format. Modern harnesses (such as Codex rollouts, OpenCode session exports, and Prime trajectories) provide ordered line-by-line event records capturing messages, tool calls, results, and compaction checkpoints.

In Terminus, semantic events are durably persisted in SQLite via `SemanticEvent` records. However, consumers previously lacked a deterministic, versioned projection from stored events into structured rollout lines suitable for evaluation datasets, debugging, and resume/fork workflows.

## Decision

1. Adopt `@terminus/rollout` as the canonical trajectory projection package:
   - `RolloutLine`: versioned envelope with dense ordinal, ISO timestamp, and typed `RolloutItem`.
   - `RolloutItem`: typed union for messages, tool calls, tool results, compactions, checkpoints, gate verdicts, usage, and generic semantic events.
   - Deterministic projection: `(occurred_at, aggregate_sequence, event_id)` total ordering.
   - Bounded by construction: lines exceeding `MAX_ROLLOUT_ITEM_BYTES` (128 KB) are rejected at encode time to prevent silent truncation.
   - Wire formats: JSON array and newline-delimited JSON (JSONL).
2. Wire `GET /v1/sessions/:id/rollout` in the control plane:
   - Queries session-scoped `SemanticEvent` records across session, thread, turn, and task aggregates.
   - Projects rows into ordered rollout lines using `@terminus/rollout`.
   - Supports cursor-based pagination and content negotiation (`application/json` or `application/x-ndjson`).
3. Retain `SemanticEvent` in SQLite as the single source of truth (no duplicate write path).

## Consequences

- Trajectories can be exported losslessly as JSONL or queried via the REST API.
- Offline evals and fine-tuning pipelines have a standardized format containing execution history and gate verdicts.

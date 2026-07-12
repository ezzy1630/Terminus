# ADR-0011: Provenance DAG checkpoints

- **Status:** ADOPTED
- **Date:** 2025-07-11
- **Decision owner:** context owner
- **Supersedes:** none
- **Related:** SPEC §9, §33.16

## Context

Long-horizon tasks accumulate turns, tool calls, and world-state changes. Two failure modes dominate:

1. **Compaction drops a requirement.** A summary or checkpoint silently omits a hard-required fragment, and the model proceeds without it. This causes subtle task failures that are hard to diagnose.
2. **Stale context.** A checkpoint references a world-state version that has since changed, and the model acts on stale information.

Raw transcript retention solves neither: it doesn't make the checkpoint auditable, and it doesn't link the checkpoint to its evidence. We need a structured checkpoint that is (a) linked to raw evidence, (b) validated against the active contract/requirements/failures, and (c) expandable back to raw evidence on demand.

## Decision

Adopt a **provenance DAG with structured checkpoints** per SPEC §9 and §33.16:

1. **Lossless provenance DAG** (SPEC §9.1) — every checkpoint, fragment, tool result, and provider attempt is a node in a directed acyclic graph. Edges represent derivation. Raw evidence (tool output, full provider responses) is always reachable by expanding edges.
2. **Structured checkpoint schema** (SPEC §9.3) — `prompts/checkpoint/template.md` defines the YAML checkpoint template: objective, completed steps, pending steps, requirements, assumptions, unknowns, decisions, failures, open questions, source versions. Composition rules enforce that hard-required fragments are retained.
3. **Checkpoint validator** (SPEC §33.13) — before a checkpoint is used as context, it is validated against the active task contract, acceptance criteria, and recorded failures. A checkpoint that drops a hard-required fragment is rejected.
4. **Deterministic vs. semantic state** (SPEC §9.2) — deterministic state (source versions, artifact hashes, tool results) is exact and immutable; semantic state (summaries, checkpoints, memory) is derived and must be re-derivable from the DAG.
5. **Triggers** (SPEC §9.4) — checkpoints are created on defined triggers (turn boundary, compaction event, epoch change, user request).
6. **Counterfactual replay** — any checkpoint can be expanded back to raw evidence (SPEC §33.16).

## Alternatives

- **Raw transcript retention only.** Rejected (SPEC §49.6 partial): no structured checkpoint; no validator; cannot detect requirement loss.
- **Provider-native compaction.** Rejected (SPEC §49.6): opaque; cannot validate; cannot replay.
- **Checkpoint without provenance DAG.** Rejected: cannot expand back to evidence; audit requires reconstruction.

## Consequences

- Every checkpoint has a `checkpoint_id` and links to its source nodes in the DAG.
- The checkpoint validator runs on every checkpoint use; failures block the turn.
- Provenance expansion is a first-class operation (used by audit, replay, and ablation).
- The DAG is stored in SQLite (`provenance_nodes`, `provenance_edges` tables) with content in the artifact store.

## Security Impact

Medium. Provenance DAG enables forensic investigation of prompt-injection incidents (which fragment introduced the taint?). Checkpoint validator prevents compaction from dropping security-relevant requirements.

## Evaluation Plan

- Requirement-recall tests: compaction cannot drop hard-required fragments (SPEC §46.3).
- Counterfactual replay: checkpoint expanded back to raw evidence matches original.
- Provenance expansion: every checkpoint is reachable to raw evidence within N hops.
- Ablation: checkpoint/recent-window vs. full history on long-horizon tasks (SPEC §48.9 exit gate).

## Migration

OpenCode's context epochs are bridged (ADR-0002). Terminus checkpoints are introduced in M6 (SPEC §48.9) and become the source of truth.

## Rollback

If checkpoints prove too expensive, reduce checkpoint frequency (fewer triggers) but do not disable the validator — that would allow requirement loss. If the DAG grows too large, apply retention (archive old raw evidence to artifact store, keep DAG nodes).

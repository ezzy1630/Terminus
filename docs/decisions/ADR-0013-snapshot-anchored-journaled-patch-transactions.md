# ADR-0013: Snapshot-anchored journaled patch transactions

- **Status:** ADOPTED
- **Date:** 2025-07-11
- **Decision owner:** ACI owner
- **Supersedes:** none
- **Related:** SPEC §11.6, §34.7, §34.8, §34.9, §34.10

## Context

Model-generated edits fail in many ways: the model's expected baseline doesn't match the file (stale write), the patch corrupts the file (parser failure), the patch partially applies (inconsistent state), or the process crashes mid-apply (unknown settlement). Each of these violates a non-negotiable invariant (SPEC §26.3 #4, #5, #9).

A naive "apply diff to file" approach cannot satisfy these invariants. We need a transactional patch engine with snapshot anchoring, journaling, validation, and crash recovery.

## Decision

Adopt **snapshot-anchored journaled patch transactions** per SPEC §11.6, §34.7–34.10:

1. **Workspace baseline** — every patch references a `WorkspaceBaseline` (workspace ID, repository revision, dirty digest, per-file source hashes). Stale writes are rejected (SPEC §26.3 #5).
2. **Patch edits** — oneof of `ReplaceSymbol`, `ReplaceRange`, `ReplaceExactText`, `InsertContent`, `DeleteRange`, `CreateFile`, `MoveFile`, `DeleteFile`, `UnifiedDiff` (SPEC §34.7, Appendix D).
3. **Journal** — every patch transaction is journaled before apply. The journal records the baseline, edits, validation profile, commit mode, and state transitions.
4. **Validation profiles** — `format-and-parse`, `parse-only`, `none` (SPEC §34.9). Validation runs after apply and may reject the transaction (rolling back).
5. **Commit modes** — `PREVIEW_ONLY` (validate, write nothing), `STAGE_ONLY` (stage to journal), `APPLY_TO_WORKTREE` (commit to working tree) (Appendix D).
6. **Crash recovery** — on restart, the journal is replayed. Any transaction in an unknown state is reconciled to a known state (applied or rolled back) before the kernel accepts new patches.
7. **Transient-invalid isolated mode** — `allow_transient_invalid_state` flag permits a multi-file transaction to be in a transient-invalid state between edits, with final validation at commit (SPEC §11.6, §34.9).
8. **Path leases** — long-running transactions acquire leases on paths to prevent concurrent conflicting edits (SPEC §34.7).

Implementation: `crates/forge-patch` (engine, journal, validation) and `crates/forge-fs` (safe path resolution, snapshots).

## Alternatives

- **Direct file writes.** Rejected: violates stale-write invariant (SPEC §26.3 #5); no crash recovery; no validation.
- **Git commits as the only transaction.** Rejected: too coarse; no partial rollback; no validation profile.
- **Operational transform (OT).** Rejected: designed for concurrent editing, not for model-generated patches; overkill.
- **CRDTs.** Rejected: same as OT; not designed for this use case.

## Consequences

- Every patch has a `transaction_id` (idempotency key) and a state machine: `staged → applied | rolled-back | failed`.
- The journal is durable; crash recovery is tested at every commit step (SPEC §46.5, §46.9).
- Patch responses include `final_repository_revision`, `final_dirty_digest`, `changed_files`, `validations`, and `complete_diff` artifact.
- Multi-file transactions are first-class (SPEC §11.6).

## Security Impact

High. Stale-write prevention (SPEC §26.3 #5) requires snapshot anchoring. Path traversal prevention requires the safe path resolver (SPEC §36.16). Validation profiles prevent malformed code from corrupting the worktree.

## Evaluation Plan

- Property tests: patch round-trip plus rollback restores exact bytes (SPEC §46.3).
- Crash recovery: forced crash at every commit step; journal replays to a known state (SPEC §46.5, §46.9).
- Concurrent-edit tests: stale-baseline rejection; path lease enforcement.
- Multi-file transaction tests: transient-invalid isolated mode; final validation.

## Migration

The patch engine is introduced in M5 (SPEC §48.8). OpenCode's edit operations are routed through it (ADR-0002). The minimal baseline (ADR-0025) uses the same engine.

## Rollback

If a validation profile proves too strict, relax it via a new profile (do not disable validation globally). If the journal proves too slow, optimize the journal implementation (do not bypass it — that violates crash recovery).

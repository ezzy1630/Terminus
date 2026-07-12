# AGENTS.md — terminus-patch

## Local rules

- **Source-hash anchored.** Every edit on an existing file MUST specify
  `expected_sha256`. Reject stale sources with `PatchError::StaleSource`.
- **Per-path leases in sorted order.** Acquire leases lexicographically to
  avoid deadlock between concurrent transactions.
- **Overlay + journal + rollback.** Every transaction MUST:
  1. snapshot affected files into `$state/tx-<id>/`,
  2. write a journal entry per step,
  3. on failure, roll back from snapshots and append `RollbackCompleted`.
- **Atomic at the transaction layer.** Never claim native filesystem
  atomicity (SPEC.md Section 34.8).
- **No `unsafe`.** No panics.
- **Validation is pluggable.** New validators go in `validate.rs` and are
  dispatched based on `ValidationProfile`.

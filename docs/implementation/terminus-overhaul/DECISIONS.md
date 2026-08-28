# Terminus overhaul decisions

## D-001, work from the exact current checkout

The current checkout is `/Volumes/Workspace/Terminus`, branch `main`, at `5f68925062cc3579e94c8e5f9a56b8b5ec46bfb9`. It is clean. I will not reset it to the audit baseline or touch the other registered worktrees. This keeps the user's visible checkout and evidence aligned.

## D-002, preserve the existing kernel and durable stores

The repository already has a Rust kernel boundary, SQLite/Prisma models, semantic events, artifacts, context manifests, verification plans, and typed provider packages. The overhaul will strengthen those paths instead of creating a second runtime or bypassing the kernel.

## D-003, safe compaction before useful compaction

The control-plane caller supplies metadata-only episodes to `runCompaction`, while the service can hide rows. That is unsafe because the summary has no source body or immutable artifact reference to cite. The interim rule is fail closed. A failed or unavailable summary must leave all source episodes visible. Structured cited compaction can be enabled only after its transaction and replay tests exist.

## D-004, terminal turn publication follows verification

The current live path emits `turn.completed`, checkpoints, and only then starts task verification. For a task turn, that sequence is not truthful. The model response remains a completion proposal. The terminal turn event and success checkpoint move after verification admission. Non-success outcomes use typed blocked, user-action, budget, aborted, or failed events.

## D-005, advanced features stay measurable and reversible

The router, scout, clean-context reviewer, browser, desktop, memory, and refinement systems are not promoted by source presence. Until paired held-out evidence exists, they remain default-off or experimental, with telemetry and an explicit rollback path. The existing control path's scout default-on behavior is a defect against this decision and is queued for correction.

## D-006, small composable state-machine helpers

The durable state model will be extracted in focused modules with transition tables and transaction callbacks. I will not split the service into network microservices merely to reduce the line count.

## D-007, evidence wording

Local tests prove local behavior only. A clean local run does not prove hosted CI, live-provider inference, secure backend enforcement on another OS, signed provenance, or held-out benchmark quality. `EVIDENCE.md` records those distinctions explicitly.

## D-008, scout remains opt-in

Scout execution is disabled by default and accepts only the explicit `TERMINUS_ENABLE_SCOUT=1` opt-in. Its utility ledger remains observable and bounded, but no default promotion is justified before paired cost/quality evidence exists.

## D-009, repository instructions enter through the kernel

Repository instruction files are discovered from task-relevant scopes and read through the kernel READ capability. They become source-hashed required compiler fragments with explicit path, precedence, scope, and truncation metadata. The loader never opens workspace files directly or grants write/exec authority.

## D-010, recovery quarantines unsafe continuation

Recovery may resume only when provider, tool, and effect state is unambiguous. A verified/finalizing turn without a completion proposal artifact is quarantined as failed/blocked with a recovery event rather than replaying an external effect. Full response-validation and verification continuation remains a follow-up slice.

## D-011, ruleset application is an external mutation

The protected-main ruleset is checked in as JSON with a dry-run-by-default `gh` script. The live repository was inspected read-only and does not yet match the target. Applying or changing the remote ruleset requires explicit authorization immediately before that mutation.

## D-012, compaction needs source and provenance

Byte metadata can select compaction candidates but cannot justify hiding them. The compactor requires materialized content and an immutable artifact reference, appends a cited summary first, and uses an atomic production commit callback before source rows leave the model-visible projection.

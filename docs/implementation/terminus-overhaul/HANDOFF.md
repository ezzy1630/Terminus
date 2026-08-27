# Terminus overhaul handoff

Read this file, `STATUS.md`, and the current Git diff before resuming.

## Current position

- Exact checkout: `/Volumes/Neural/Terminus`.
- Branch: `main`. Functional verification-recovery commits `d3760b1`, `ea7f34a`, and `c04ff58`, plus signal-derived plan commit `a42acc5`, are complete; the evidence ledger records this slice and no push was performed.
- Task-owned functional paths are clean at `a42acc5`; `SPEC.md` retains a pre-existing user edit. Other registered worktrees remain untouched.
- Durable ledger files live in `docs/implementation/terminus-overhaul/`.
- The implementation slice covers lifecycle ordering, recovery boundaries, cancellation, safe compaction, context instructions, provider stream/abort handling, anonymous OpenCode Zen free-model inference through the kernel, durable provider-attempt identity and native response metadata, no-duplicate in-flight provider recovery, cumulative repair, durable repair attempts and fencing leases, durable completion admission recovery, candidate-branch admission fencing and manual-review recovery, exact verification resume from persisted response/plan/result identity, default-off scout behavior, CI/ruleset declarations, evaluation-run contracts, and the Prisma DateTime upgrade migration.

## Remaining blockers

1. The live `main-protection` ruleset (id `21228252`) is weaker than the checked-in target. Applying it is a remote mutation and was not authorized.
2. Hosted CI/bootstrap, paid-account and alternate-provider live conformance, cross-platform sandbox enforcement, signed release artifacts, and private holdout evaluations are not proven locally. The anonymous OpenCode Zen free-model path is now proven; see `EVIDENCE.md`.
3. `RESPONSE_VALIDATING`/`VERIFYING` now resume from a durable response artifact and exact persisted verification identity without replaying the provider; stale, malformed, or legacy state fails closed. Full live restart and fault-injection proof remains open. Durable repair attempts now have a parent/child record, task-level budget/provenance, and a fenced lease; verification node IDs are plan-scoped so a repair plan cannot collide with its parent in Prisma.
4. New verification plans derive typed predicates from contract, changed/scope paths, risk, instructions, current failures/diagnostics, generated paths, and supplied native commands. Admission checks are required; incremental hygiene checks are optional and cannot block required criteria. Automatic repository-map/native-recipe discovery and governed UI execution remain open.
4. Successful automatic checkpoint publication is atomic with terminal publication, and coupled restart recovery is tested. Ambiguous v1 effects now recover atomically into tool `UNKNOWN`/effect `MANUAL_REVIEW` with one replay-safe event; in-flight provider attempts now become interrupted with blocked tasks and one replay-safe recovery event. Provider-attempt identity and native response/continuation IDs are durable and DB replay-tested. Proposal publication remains non-terminal; response-validation recovery reuses the durable response/verification boundary and fails closed on stale or incomplete state. Cancellation now commits all active-turn/task abort rows and events atomically before signaling in-process work. Candidate branches now fence `OPEN` -> `ADMITTING` and recover conservatively to `MANUAL_REVIEW` with a replay-safe event and blocked task when no trusted merge receipt exists. Checkpoint preparation failure remains explicit/best-effort; trusted external merge-receipt reconciliation and later-state recovery remain open.

## Safe working rules

- Do not reset, clean, rebase, merge, push, or touch the other worktrees.
- Use `apply_patch` for source edits.
- Keep provider requests, filesystem/process effects, and secrets behind the existing kernel boundary.
- Run focused tests after each slice. Run `just check`, `just codegen-check`, and applicable suites before claiming a gate.
- If a command is long or noisy, inspect its useful failing tail and record the exact status in `EVIDENCE.md`.

## Verified local commands

- `bun test ...` focused continuation set: 3 proposal/cancellation recovery tests passed, 0 failed, 22 expect calls; the original overhaul and broader continuation sets remain recorded in `EVIDENCE.md`.
- `bun test mini-services/terminus-control/src/services/services.test.ts tests/recovery/completion_admission_recovery.test.ts tests/persistence/migration_integrity.test.ts`: 18 passed, 0 failed, 91 expect calls, including coordinator propagation, completion admission rollback/replay/quarantine, and migration read-back.
- `bun test tests/persistence/migration_integrity.test.ts`: 5 passed, 0 failed, including the repair-attempt schema/uniqueness read-back and legacy provider timestamp conversion with millisecond precision.
- `just codegen`: passed.
- `just codegen-check`: passed from committed `5f6a803`, including the `tool.settlement_unknown` event catalog/docs update.
- `just check`: passed on the repair-attempt slice; existing clippy warnings and two generated-file ESLint warnings remain non-fatal.
- `just check-all`: passed from committed `327444f`; 583 TypeScript tests, 257 Python tests, full local Rust integration/security, platform probes, standalone/truth checks, generated-contract validation, and `cargo deny` passed. One explicitly ignored live conformance canary remains.
- `just standalone-check`: passed.
- `just truth-check`: passed.
- `just github-ruleset-plan`: passed read-only.
- `just github-ruleset-verify`: failed against the current weaker remote ruleset, as expected.
- `just fault-injection`: passed — 35 recovery tests, including DB-backed effect, repair, proposal/cancellation, checkpoint-publication, completion-admission, provider-attempt-identity, and provider-attempt-recovery scenarios; the artifact has 13 fixture-only boundaries, 11 DB-backed scenarios, and explicitly remains `completeForRelease: false`.
- `bun test packages/verification/src/plan-derivation.test.ts packages/verification/src/verification.test.ts packages/verification/src/exit-gate.test.ts tests/recovery/verification_recovery.test.ts mini-services/terminus-control/src/verification-runtime.test.ts`: 41 passed, 0 failed, 120 expect calls.
- `bun run typecheck --pretty false`: passed after the signal-derived verification-plan integration.
- `bun test packages/runtime-protocol/src/v2_protocol.test.ts`: 6 passed, 0 failed.
- `bun test packages/task-runtime/src/effects.test.ts tests/recovery/branch_admission_recovery.test.ts tests/recovery/proposal_cancellation_recovery.test.ts`: 29 passed, 0 failed, 90 expect calls.
- `bun test tests/persistence/migration_integrity.test.ts`: 5 passed, 0 failed, including migration `0015_candidate_branch_admission_recovery.sql`.
- `bun run typecheck`: passed with no diagnostics after the branch-admission state/event additions.
- `just fault-injection`: passed — 37 recovery tests, 13 fixture-only boundaries, 12 DB-backed scenarios, and `completeForRelease: false`; the artifact includes `branch_admission_recovery_replay`.
- `bun test tests/recovery/verification_recovery.test.ts`: passed — 1 fresh-migration DB-backed test, 0 failures, 7 expect calls; persisted plan/result identity was reconstructed and only the missing node executed.
- `bun test tests/recovery/verification_recovery.test.ts packages/verification/src/verification.test.ts packages/verification/src/exit-gate.test.ts`: passed — 36 tests, 0 failures, 95 expect calls.
- `bun run typecheck --pretty false`: passed with no diagnostics after the verification-recovery changes.
- `just fault-injection`: passed — 38 recovery tests, 13 fixture-only boundaries, 13 DB-backed scenarios, and `completeForRelease: false`; the artifact includes `verification_recovery_replay`.
- `just codegen-check`: passed after `d3760b1`; migration `0016_verification_recovery_identity.sql` and generated documentation are stable.

## Resume sequence

1. Inspect `git status --short --branch`, the last commit, and all four ledger files.
2. If the user authorizes remote branch-protection mutation, run `just github-ruleset-apply`, then `just github-ruleset-verify` and read back the exact remote settings.
3. Add a trusted external merge-receipt query and later state recovery. The conservative branch-admission `ADMITTING` -> `MANUAL_REVIEW` replay path is covered, alongside effect recovery, proposal/cancellation, completion admission, coupled checkpoint/terminal publication, provider-attempt identity/recovery, repair continuation, and verification resume; trusted receipts and later-state recovery remain before release readiness.

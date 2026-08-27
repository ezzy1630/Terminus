# Terminus overhaul handoff

Read this file, `STATUS.md`, and the current Git diff before resuming.

## Current position

- Exact checkout: `/Volumes/Neural/Terminus`.
- Branch: `main`. The current implementation head is `6850036` (`Wire revisioned repository maps and native recipe discovery`); no push was performed.
- Task-owned functional paths are clean at `6850036`; `SPEC.md` retains a pre-existing user edit. Other registered worktrees remain untouched.
- Durable ledger files live in `docs/implementation/terminus-overhaul/`.
- The implementation slice covers lifecycle ordering, recovery boundaries, cancellation, safe compaction, context instructions, provider stream/abort handling, anonymous OpenCode Zen free-model inference through the kernel, durable provider-attempt identity and native response metadata, no-duplicate in-flight provider recovery, cumulative repair, durable repair attempts and fencing leases, durable completion admission recovery, candidate-branch admission fencing and manual-review recovery, exact verification resume from persisted response/plan/result identity, default-off scout behavior, CI/ruleset declarations, evaluation-run contracts, the Prisma DateTime upgrade migration, exact provider cost accounting, and revisioned kernel repository-map/native-recipe discovery.
- The latest slice also derives provider-neutral repair metrics from durable records, exposes them from `GET /v1/tasks/:id`, and makes normalized evidence references part of the no-progress signature.

## Remaining blockers

1. The live `main-protection` ruleset (id `21228252`) is weaker than the checked-in target. Applying it is a remote mutation and was not authorized.
2. Hosted CI/bootstrap, paid-account and alternate-provider live conformance, cross-platform sandbox enforcement, signed release artifacts, and private holdout evaluations are not proven locally. The anonymous OpenCode Zen free-model path is now proven; see `EVIDENCE.md`.
3. `RESPONSE_VALIDATING`/`VERIFYING` now resume from a durable response artifact and exact persisted verification identity without replaying the provider; stale, malformed, or legacy state fails closed. Full live restart and fault-injection proof remains open. Durable repair attempts now have a parent/child record, task-level budget/provenance, and a fenced lease; verification node IDs are plan-scoped so a repair plan cannot collide with its parent in Prisma. Repair metrics are derived, exposed, and locally aggregatable from the durable database. Exact cost accounting is now split into provider-reported, computed, and source fields, but trusted provider billing, live export, and metrics restart proof remain open.
4. New verification plans derive typed predicates from contract, changed/scope paths, risk, instructions, current failures/diagnostics, generated paths, and supplied native commands. Admission checks are required; incremental hygiene checks are optional and cannot block required criteria. Automatic repository-map/native-recipe discovery is now wired through task-scoped kernel reads and the revisioned `CodeIntelligenceService.Map` RPC, with source versions, explicit omissions, and unavailable signals preserved. The current caller hydrates one bounded page and exposes its opaque continuation; governed UI execution remains open.
5. Successful automatic checkpoint publication is atomic with terminal publication, and coupled restart recovery is tested. Ambiguous v1 effects now recover atomically into tool `UNKNOWN`/effect `MANUAL_REVIEW` with one replay-safe event; in-flight provider attempts now become interrupted with blocked tasks and one replay-safe recovery event. Provider-attempt identity and native response/continuation IDs are durable and DB replay-tested. Proposal publication remains non-terminal; response-validation recovery reuses the durable response/verification boundary and fails closed on stale or incomplete state. Cancellation now commits all active-turn/task abort rows and events atomically before signaling in-process work. Candidate branches now fence `OPEN` -> `ADMITTING` and recover conservatively to `MANUAL_REVIEW` with a replay-safe event and blocked task when no trusted merge receipt exists. Checkpoint preparation failure remains explicit/best-effort; trusted external merge-receipt reconciliation and later-state recovery remain open.

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
- `bun test ...` repair-metrics continuation set: 61 passed, 0 failed, 187 expect calls.
- `bun run typecheck --pretty false`: passed after `c94f7fd`.
- `just check`: passed after `c94f7fd`.
- `just codegen-check`: passed after committing `c94f7fd`.
- `just fault-injection`: passed after `c94f7fd`; 13 DB-backed scenarios, `completeForRelease: false`.
- `bun test packages/provider-core/src/cost.test.ts packages/provider-economics/src/economics.test.ts mini-services/terminus-control/src/services/services.test.ts`: passed — 15 tests, 0 failures, 54 expect calls.
- `bun test tests/persistence/migration_integrity.test.ts`: passed — 5 tests, 0 failures, 34 expect calls, including migration `0017_provider_attempt_cost_accounting.sql`.
- `bun run typecheck --pretty false`: passed after `09b9d38`.
- `just codegen`: passed after migration `0017_provider_attempt_cost_accounting.sql`; inventory records 122 TypeScript test files, 952 declared TypeScript test blocks, and 17 SQLite migrations.
- `just check-all` after `09b9d38`: passed; boundary, Rust, TypeScript, Python, integration, security, standalone/truth, generated-contract, and `cargo deny` checks completed. One explicitly ignored live conformance canary remains.
- Fresh database migrated through `0017_provider_attempt_cost_accounting.sql` plus the ops collector: passed; the new cost columns were read and the empty aggregate remained explicit.
- `bun test mini-services/terminus-control/src/agent/repository-signals.test.ts mini-services/terminus-control/src/agent/retrieval-hydrator.test.ts packages/verification/src/plan-derivation.test.ts`: passed — 13 tests, 0 failures, 44 expect calls; native recipe parsing, map-fragment continuation rendering, and signal-derived verification plans pass.
- `cargo test -p terminus-code-intel && cargo test -p terminus-authz`: passed — 13 code-intelligence tests and 17 authorization tests, 0 failures.
- `cargo test --manifest-path mini-services/terminus-kernel/Cargo.toml`: passed — 12 tests, 0 failures, including scoped map paging and stale-continuation rejection.
- `bun run typecheck --pretty false`: passed with no diagnostics after repository discovery wiring.
- `just check`: passed — boundary checks, Rust fmt/clippy, ESLint with 0 errors and 2 existing generated-file warnings, package/scripts/root TypeScript, and Python ruff/mypy.
- `just codegen-check`: passed from committed `6850036`; generated protobuf, API, schema, and documentation outputs are stable.
- `just check-all` from committed `6850036`: passed — full local boundary, Rust, TypeScript, Python, integration, security, standalone/truth, generated-contract, and dependency checks; one explicitly ignored live conformance canary remains.

## Resume sequence

1. Inspect `git status --short --branch`, the last commit, and all four ledger files. The current implementation head is `6850036`; preserve the unrelated `SPEC.md` edit and do not treat the first-page map continuation as proof that all repository entries were hydrated.
2. If the user authorizes remote branch-protection mutation, run `just github-ruleset-apply`, then `just github-ruleset-verify` and read back the exact remote settings.
3. Rerun current-HEAD `just check-all` and record the terminal result. The exact provider-attempt accounting split and local repair-metric aggregation are now implemented; finish trusted provider billing receipts, live export, and restart/read-model proof without treating legacy zero-cost sentinels as measured spend.
4. Add a trusted external merge-receipt query and later state recovery. The conservative branch-admission `ADMITTING` -> `MANUAL_REVIEW` replay path is covered, alongside effect recovery, proposal/cancellation, completion admission, coupled checkpoint/terminal publication, provider-attempt identity/recovery, repair continuation, and verification resume; trusted receipts and later-state recovery remain before release readiness.
5. Add the governed UI predicate path and continue through the remaining Gate C, E, and F requirements in bounded slices. Retrieval metrics/ablation, full continuation consumption, and complete semantic plan coverage remain open around the new repository signals.

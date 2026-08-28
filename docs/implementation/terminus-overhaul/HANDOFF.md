# Terminus overhaul handoff

Read this file, `STATUS.md`, and the current Git diff before resuming.

## Current position

- Exact checkout: `/Volumes/Workspace/Terminus`.
- Branch: `main`. The current implementation head is `c56e245` (`Add trusted candidate merge receipt recovery`); the local branch is 57 commits ahead of `origin/main` and no push was performed.
- Task-owned functional paths are clean at `c56e245`; `SPEC.md` retains a pre-existing user edit and must not be staged. Other registered worktrees remain untouched.
- Durable ledger files live in `docs/implementation/terminus-overhaul/`.
- The implementation slice covers lifecycle ordering, recovery boundaries, cancellation, safe compaction, context instructions, provider stream/abort handling, anonymous OpenCode Zen free-model inference through the kernel, durable provider-attempt identity and native response metadata, no-duplicate in-flight provider recovery, cumulative repair, durable repair attempts and fencing leases, durable completion admission recovery, candidate-branch admission fencing and manual-review recovery, exact verification resume from persisted response/plan/result identity, default-off scout behavior, CI/ruleset declarations, evaluation-run contracts, the Prisma DateTime upgrade migrations including the fresh-database `BIGINT` repair, exact provider cost accounting, revisioned kernel repository-map/native-recipe discovery, versioned retrieval selection metrics with deterministic scoring ablations, durable provider cache observation read-back, typed fail-closed governed UI predicate derivation, provider-neutral repair metrics, and the provider-neutral trusted candidate merge-receipt contract.
- The latest slice (c56e245, migration `0019_candidate_branch_merge_receipts.sql`) adds `CandidateBranchMergeReceipt` binding status/operation ID/artifact hash/branch-task-attempt-actor identity/revisions/scope/completion-record digest/merge ID, plus `AdmissionService.reconcileAdmittingBranch` which validates a trusted receipt without ever invoking the merge adapter, commits `EXECUTED` receipts to `ADMITTED`, retains `NOT_EXECUTED`/`AMBIGUOUS` receipts in `MANUAL_REVIEW`, and fails closed on absent or mismatched receipts. This is a durable contract and local recovery transition, not proof of a configured real external Git/merge adapter.

## Remaining blockers

1. The live `main-protection` ruleset (id `21228252`) is weaker than the checked-in target. Applying it is a remote mutation and was not authorized.
2. Hosted CI/bootstrap, paid-account and alternate-provider live conformance, cross-platform sandbox enforcement, signed release artifacts, and private holdout evaluations are not proven locally. The anonymous OpenCode Zen free-model path and a fresh eight-task cache cohort are proven; the local average threshold is measured at `0.7664` against `0.7`, while 20-run promotion and broader release/evaluation evidence remain open. See `EVIDENCE.md`.
3. `RESPONSE_VALIDATING`/`VERIFYING` now resume from a durable response artifact and exact persisted verification identity without replaying the provider; stale, malformed, or legacy state fails closed. Full live restart and fault-injection proof remains open. Durable repair attempts now have a parent/child record, task-level budget/provenance, and a fenced lease; verification node IDs are plan-scoped so a repair plan cannot collide with its parent in Prisma. Repair metrics are derived, exposed, and locally aggregatable from the durable database. Exact cost accounting is now split into provider-reported, computed, and source fields, but trusted provider billing, live export, and metrics restart proof remain open.
4. The trusted merge-receipt recovery contract is durable (`reconcileAdmittingBranch`, migration `0019`), but no real external Git/merge receipt source is configured: `mini-services/terminus-control/src/index.ts` still uses the conservative startup path that moves `ADMITTING` branches to `MANUAL_REVIEW` when no receipt query is supplied, `createPrismaCompletionAdmission()` accepts an optional receipt query that the live startup path does not wire, and no remote receipt, one-query-only live replay, or startup auto-promotion has been proven. Startup recovery also does not yet emit a semantic event for every generic branch state update, and some database JSON decoding still uses casts.
5. New verification plans derive typed predicates from contract, changed/scope paths, risk, instructions, current failures/diagnostics, generated paths, and supplied native commands. Admission checks are required; incremental hygiene checks are optional and cannot block required criteria. Automatic repository-map/native-recipe discovery now follows every opaque continuation through task-scoped kernel reads, validates one revision and declared total, fails closed on malformed/repeated/incomplete pages, and projects at most 200 complete entries into model context with explicit omissions. Retrieval selection facts, omission reasons, exact token costs, additive scoring, and one-at-a-time offline weight ablations are now persisted with the context manifest. Provider settlement now persists predicted and realized cached-token observations and `getManifest` reads valid values back without coercing malformed data. UI-looking criteria now derive `ui_e2e`; when governed computer use is unavailable, verification emits a durable blocked result without invoking the generic command runner. The fresh eight-task cohort recorded one cold miss and seven 0.8759 warm ratios, with average telemetry 0.7664 at the local 0.7 threshold; 20-run promotion, labeled outcome metrics, monorepo-scale evidence, and actual governed UI execution remain open.
6. Successful automatic checkpoint publication is atomic with terminal publication, and coupled restart recovery is tested. Ambiguous v1 effects now recover atomically into tool `UNKNOWN`/effect `MANUAL_REVIEW` with one replay-safe event; in-flight provider attempts now become interrupted with blocked tasks and one replay-safe recovery event. Provider-attempt identity and native response/continuation IDs are durable and DB replay-tested. Proposal publication remains non-terminal; response-validation recovery reuses the durable response/verification boundary and fails closed on stale or incomplete state. Cancellation now commits all active-turn/task abort rows and events atomically before signaling in-process work. Candidate branches now fence `OPEN` -> `ADMITTING` and recover conservatively to `MANUAL_REVIEW` with a replay-safe event and blocked task when no trusted merge receipt exists. Checkpoint preparation failure remains explicit/best-effort; trusted external merge-receipt reconciliation and later-state recovery remain open.

## Safe working rules

- Do not reset, clean, rebase, merge, push, or touch the other worktrees.
- Use `apply_patch` for source edits.
- Keep provider requests, filesystem/process effects, and secrets behind the existing kernel boundary.
- Run focused tests after each slice. Run `just check`, `just codegen-check`, and applicable suites before claiming a gate.
- If a command is long or noisy, inspect its useful failing tail and record the exact status in `EVIDENCE.md`.

## Verified local commands

- `bun test ...` focused continuation set: 3 proposal/cancellation recovery tests passed, 0 failed, 22 expect calls; the original overhaul and broader continuation sets remain recorded in `EVIDENCE.md`.
- `bun test mini-services/terminus-control/src/services/services.test.ts tests/recovery/completion_admission_recovery.test.ts tests/persistence/migration_integrity.test.ts`: 18 passed, 0 failed, 91 expect calls, including coordinator propagation, completion admission rollback/replay/quarantine, and migration read-back.
- `bun test tests/persistence/migration_integrity.test.ts`: 5 passed, 0 failed, including the Prisma provider timestamp write/read regression against a fresh database migrated through migration `0018`.
- `just codegen`: passed.
- `just codegen-check`: passed from committed `69ffb70`, including migration `0018_provider_datetime_bigint.sql` in generated documentation.
- `just check`: passed on the repair-attempt slice; existing clippy warnings and two generated-file ESLint warnings remain non-fatal.
- `just check` at implementation head `69ffb70`: passed; existing clippy warnings and two generated-file ESLint warnings remain non-fatal.
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
- `bun test mini-services/terminus-control/src/agent/repository-map.test.ts mini-services/terminus-control/src/agent/retrieval-hydrator.test.ts mini-services/terminus-control/src/agent/repository-signals.test.ts packages/verification/src/plan-derivation.test.ts`: passed — 19 tests, 0 failures, 59 expect calls; complete continuation reads, revision/count/ordering/bounds rejection, prompt omission behavior, native recipes, and signal-derived plans pass.
- `just check-all` after `8a2923d`: passed — the full local command exited 0; boundary, Rust, TypeScript, Python, integration, security, standalone/truth, generated-contract, and dependency checks passed. One explicitly ignored live conformance canary remains.
- `bash scripts/e2e/deterministic.sh` after `8a2923d`: failed in the unchanged restart harness after receiving 1,005 of 1,006 expected SSE events; the missing event was the live `task.aborted` overlap event and the harness timed out after 10 seconds. This is not repository-map evidence and remains an integration validation blocker.
- `bun test packages/context-compiler/src`: passed — 46 tests, 0 failures, 163 expect calls; retrieval selection/outcome aggregation, scoring ablation, manifest persistence, cache diagnostics, compaction, replay, and existing context invariants pass.
- `bun test mini-services/terminus-control/src/context-store.test.ts mini-services/terminus-control/src/agent/cache-telemetry.test.ts mini-services/terminus-control/src/direct-provider-transport.test.ts packages/context-compiler/src`: passed — 62 tests, 0 failures, 208 expect calls; valid provider cache observations read back as exact counts and malformed or absent observations remain null.
- `bun run typecheck --pretty false`: passed — root TypeScript typecheck completed with no diagnostics after retrieval metric integration.
- `just check`: passed — boundary checks, Rust fmt/clippy, ESLint with 0 errors and 2 existing generated-file warnings, package/scripts/root TypeScript, and Python ruff/mypy.
- `just codegen-check` from committed `410685f`: passed — generated protobuf, API, event, tool, config, schema, SQLx, and documentation outputs are stable.
- `just check-all` after `410685f`: passed — the full local command exited 0; boundary, Rust, TypeScript, Python, integration, security, standalone/truth, generated-contract, and dependency checks passed. One explicitly ignored live conformance canary remains.
- `just codegen-check` from committed `050115f`: passed — generated protobuf, API, event, tool, config, schema, SQLx, and documentation outputs are stable after cache read-back wiring.
- `just check-all` after `050115f`: passed — the full local command exited 0; 599 Bun unit tests, 257 Python tests, 294 integration tests, Rust workspace tests, security suites, platform probes, standalone/truth, generated-contract, and dependency checks passed. One explicitly ignored live conformance canary remains.
- `bun test packages/verification/src`: passed — 55 tests, 0 failures, 169 expect calls, including typed UI derivation and fail-closed unavailable-backend coverage.
- `just check` after the UI slice committed as `b693ddb`: passed — boundary checks, Rust fmt/clippy, ESLint with 0 errors and 2 existing generated-file warnings, package/scripts/root TypeScript, and Python ruff/mypy.
- `just codegen-check` from committed `b693ddb`: passed — generated protobuf, API, event, tool, config, schema, SQLx, and documentation outputs are stable.
- `just check-all` after `b693ddb`: passed — 601 Bun unit tests, 257 Python tests, Rust workspace and integration/security tests, platform probes, standalone/truth, generated-contract, and dependency checks passed. One explicitly ignored live conformance canary remains.
- `just check-all` at implementation head `69ffb70`: passed — the full local boundary, Rust, TypeScript, Python, integration, security, standalone/truth, generated-contract, platform, and dependency checks exited 0. One explicitly ignored live conformance canary remains.
- Isolated fresh kernel/control stack with anonymous `hy3-free`: passed — task `f855f39d-22a9-4d17-838e-65bf275068e2`, turn `693e4cb1-f2eb-4c87-8547-5fd5e2fae603`, and provider attempt `d8b9cf1d-8b28-4b6c-8eb7-28399f83dd7b` completed through verification and branch admission; the kernel connector returned HTTP 200, usage recorded 896 cached input tokens against 1025 predicted, and the durable cache ratio was `0.8741`.
- Fresh eight-task anonymous Zen cache cohort: passed — all tasks and turns completed; one cold observation was `0/1023`, seven warm observations were `896/1023` (`0.8759` each), and the collector reported average `0.7664` at threshold `0.7` with zero warnings.
- `TERMINUS_CACHE_TELEMETRY_DB=<fresh cohort control database> bun run scripts/collect-cache-telemetry.ts`: passed — `status=measured`, 8 observations, average `0.7664`, minimum `0`, zero warnings.
- `just m12-exit-gate`: blocked by the release-source dirty-worktree guard because the preserved user-owned `SPEC.md` edit remains uncommitted; no release decision was produced.

## Resume sequence

1. Inspect `git status --short --branch`, the last commit, and all ledger files. The current implementation head is `c56e245` with migration `0019_candidate_branch_merge_receipts.sql`; preserve the unrelated `SPEC.md` edit. Repository-map continuation consumption is bounded and complete-read validated; do not treat the 200-entry model projection as the full map. Retrieval selection metrics and deterministic scoring ablations are wired, but they have no held-out outcome labels yet. One fresh eight-task cache cohort satisfies the local average telemetry threshold but is not the 20-run promotion cohort. UI-looking criteria now have an explicit `ui_e2e` predicate and unavailable capability blocks with evidence; the runtime still has no configured governed computer-use backend.
2. If the user authorizes remote branch-protection mutation, run `just github-ruleset-apply`, then `just github-ruleset-verify` and read back the exact remote settings.
3. Rerun current-HEAD `just check`, `just check-all`, `just fault-injection`, `just standalone-check`, and `just truth-check` from c56e245 and record exact results; the exact provider-attempt accounting split and local repair-metric aggregation are implemented, and trusted provider billing receipts, live export, and restart/read-model proof remain open.
4. Add a trusted external Git/merge receipt adapter behind the provider-neutral boundary, wire startup recovery to a configured receipt query only after it exists, persist semantic recovery events for every branch state update, and add crash tests for stale/mismatched/duplicate/partial receipt states; until then the conservative `ADMITTING` -> `MANUAL_REVIEW` startup path stays. The receipt contract itself (`reconcileAdmittingBranch`) and migration `0019` are already committed as c56e245.
5. Wire a configured governed computer-use backend into the new `ui_e2e` verifier and prove the real browser/desktop loop, then continue through the remaining Gate C, E, and F requirements in bounded slices. Run the remaining 20-run release/evaluation cohorts, evaluate retrieval metrics with labeled task cohorts, then close cache promotion, monorepo-scale evidence, and complete semantic plan coverage around the repository signals. Investigate the unchanged SSE overlap harness before using it as full lifecycle proof.

## c56e245 validation observed in the prior context

- `bun test packages/task-runtime/src/effects.test.ts`: 27 passed, 0 failed.
- `bun test tests/recovery/branch_admission_receipt_recovery.test.ts`: 1 passed, 0 failed (one-query-only replay).
- `bun test tests/recovery/branch_admission_recovery.test.ts`: 2 passed, 0 failed.
- `bun test tests/recovery/branch_admission_receipt_recovery.test.ts tests/persistence/migration_integrity.test.ts`: 6 passed, 0 failed.
- `bun run typecheck:packages`: passed.
- `bunx prisma generate` and `DATABASE_URL=file:/tmp/terminus-prisma-validate.db bunx prisma validate --schema prisma/schema.prisma`: passed.
- `just codegen` and `just codegen-check` from committed c56e245: passed.
- `bunx tsc --noEmit -p mini-services/terminus-control/tsconfig.json`: failed on pre-existing test typing errors in unrelated control-plane test files; do not treat that check as green.
- Current-head `just check`, `just check-all`, `just fault-injection`, `just standalone-check`, and `just truth-check` after c56e245 were not yet recorded; rerun them before handoff.
- Current-head rerun complete: at `c12f7c3` all of the above passed (see EVIDENCE.md observation 33); fault-injection artifact records 38 tests passed, 13 DB-backed scenarios, `completeForRelease: false`.

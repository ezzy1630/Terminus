# Terminus overhaul handoff

Read this file, `STATUS.md`, and the current Git diff before resuming.

## Current position

- Exact checkout: `/Volumes/Neural/Terminus`.
- Branch: `main`. The current implementation head is `b693ddb` (`Add fail-closed governed UI verification predicate`); no push was performed.
- Task-owned functional paths are clean at `b693ddb`; `SPEC.md` retains a pre-existing user edit. Other registered worktrees remain untouched.
- Durable ledger files live in `docs/implementation/terminus-overhaul/`.
- The implementation slice covers lifecycle ordering, recovery boundaries, cancellation, safe compaction, context instructions, provider stream/abort handling, anonymous OpenCode Zen free-model inference through the kernel, durable provider-attempt identity and native response metadata, no-duplicate in-flight provider recovery, cumulative repair, durable repair attempts and fencing leases, durable completion admission recovery, candidate-branch admission fencing and manual-review recovery, exact verification resume from persisted response/plan/result identity, default-off scout behavior, CI/ruleset declarations, evaluation-run contracts, the Prisma DateTime upgrade migration, exact provider cost accounting, revisioned kernel repository-map/native-recipe discovery, versioned retrieval selection metrics with deterministic scoring ablations, durable provider cache observation read-back, and typed fail-closed governed UI predicate derivation.
- The latest slice also derives provider-neutral repair metrics from durable records, exposes them from `GET /v1/tasks/:id`, and makes normalized evidence references part of the no-progress signature.

## Remaining blockers

1. The live `main-protection` ruleset (id `21228252`) is weaker than the checked-in target. Applying it is a remote mutation and was not authorized.
2. Hosted CI/bootstrap, paid-account and alternate-provider live conformance, cross-platform sandbox enforcement, signed release artifacts, and private holdout evaluations are not proven locally. The anonymous OpenCode Zen free-model path is now proven; see `EVIDENCE.md`.
3. `RESPONSE_VALIDATING`/`VERIFYING` now resume from a durable response artifact and exact persisted verification identity without replaying the provider; stale, malformed, or legacy state fails closed. Full live restart and fault-injection proof remains open. Durable repair attempts now have a parent/child record, task-level budget/provenance, and a fenced lease; verification node IDs are plan-scoped so a repair plan cannot collide with its parent in Prisma. Repair metrics are derived, exposed, and locally aggregatable from the durable database. Exact cost accounting is now split into provider-reported, computed, and source fields, but trusted provider billing, live export, and metrics restart proof remain open.
4. New verification plans derive typed predicates from contract, changed/scope paths, risk, instructions, current failures/diagnostics, generated paths, and supplied native commands. Admission checks are required; incremental hygiene checks are optional and cannot block required criteria. Automatic repository-map/native-recipe discovery now follows every opaque continuation through task-scoped kernel reads, validates one revision and declared total, fails closed on malformed/repeated/incomplete pages, and projects at most 200 complete entries into model context with explicit omissions. Retrieval selection facts, omission reasons, exact token costs, additive scoring, and one-at-a-time offline weight ablations are now persisted with the context manifest. Provider settlement now persists predicted and realized cached-token observations and `getManifest` reads valid values back without coercing malformed data. UI-looking criteria now derive `ui_e2e`; when governed computer use is unavailable, verification emits a durable blocked result without invoking the generic command runner. Fresh live cache telemetry, threshold/promotion evidence, labeled outcome metrics, monorepo-scale evidence, and actual governed UI execution remain open.
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

## Resume sequence

1. Inspect `git status --short --branch`, the last commit, and all four ledger files. The current implementation head is `b693ddb`; preserve the unrelated `SPEC.md` edit. Repository-map continuation consumption is bounded and complete-read validated; do not treat the 200-entry model projection as the full map. Retrieval selection metrics and deterministic scoring ablations are wired, but they have no held-out outcome labels yet. Provider cache observations now have durable read-back, but no fresh live cache cohort has been recorded. UI-looking criteria now have an explicit `ui_e2e` predicate and unavailable capability blocks with evidence; the runtime still has no configured governed computer-use backend.
2. If the user authorizes remote branch-protection mutation, run `just github-ruleset-apply`, then `just github-ruleset-verify` and read back the exact remote settings.
3. Rerun current-HEAD `just check-all` and record the terminal result. This is now recorded for `b693ddb`. The exact provider-attempt accounting split and local repair-metric aggregation are implemented; finish trusted provider billing receipts, live export, and restart/read-model proof without treating legacy zero-cost sentinels as measured spend.
4. Add a trusted external merge-receipt query and later state recovery. The conservative branch-admission `ADMITTING` -> `MANUAL_REVIEW` replay path is covered, alongside effect recovery, proposal/cancellation, completion admission, coupled checkpoint/terminal publication, provider-attempt identity/recovery, repair continuation, and verification resume; trusted receipts and later-state recovery remain before release readiness.
5. Wire a configured governed computer-use backend into the new `ui_e2e` verifier and prove the real browser/desktop loop, then continue through the remaining Gate C, E, and F requirements in bounded slices. Evaluate retrieval metrics with labeled task cohorts, exercise the durable cache observation path against fresh live provider runs, then close cache promotion, monorepo-scale evidence, and complete semantic plan coverage around the repository signals. Investigate the unchanged SSE overlap harness before using it as full lifecycle proof.

# Terminus overhaul handoff

Read this file, `STATUS.md`, and the current Git diff before resuming.

## Current position

- Exact checkout: `/Volumes/Neural/Terminus`.
- Branch: `main`. Functional ambiguous-effect recovery commit `5f6a803` is complete; the evidence ledger is current and no push was performed.
- The worktree was clean before the ledger files and implementation changes were added. Other registered worktrees remain untouched.
- Durable ledger files live in `docs/implementation/terminus-overhaul/`.
- The implementation slice covers lifecycle ordering, recovery boundaries, cancellation, safe compaction, context instructions, provider stream/abort handling, anonymous OpenCode Zen free-model inference through the kernel, cumulative repair, durable repair attempts and fencing leases, durable completion admission recovery, default-off scout behavior, CI/ruleset declarations, evaluation-run contracts, and the Prisma DateTime upgrade migration.

## Remaining blockers

1. The live `main-protection` ruleset (id `21228252`) is weaker than the checked-in target. Applying it is a remote mutation and was not authorized.
2. Hosted CI/bootstrap, paid-account and alternate-provider live conformance, cross-platform sandbox enforcement, signed release artifacts, and private holdout evaluations are not proven locally. The anonymous OpenCode Zen free-model path is now proven; see `EVIDENCE.md`.
3. Recovery still quarantines rather than resumes `RESPONSE_VALIDATING`/`VERIFYING`; those states need a separate no-duplicate-provider policy and fault-injection proof. Durable repair attempts now have a parent/child record, task-level budget/provenance, and a fenced lease; verification node IDs are plan-scoped so a repair plan cannot collide with its parent in Prisma.
4. Successful automatic checkpoint publication is atomic with terminal publication, and coupled restart recovery is tested. Ambiguous v1 effects now recover atomically into tool `UNKNOWN`/effect `MANUAL_REVIEW` with one replay-safe event. Checkpoint preparation failure remains explicit/best-effort. Provider request identity, trusted receipt reconciliation, and proposal/branch fault boundaries still need production-equivalent replay coverage.

## Safe working rules

- Do not reset, clean, rebase, merge, push, or touch the other worktrees.
- Use `apply_patch` for source edits.
- Keep provider requests, filesystem/process effects, and secrets behind the existing kernel boundary.
- Run focused tests after each slice. Run `just check`, `just codegen-check`, and applicable suites before claiming a gate.
- If a command is long or noisy, inspect its useful failing tail and record the exact status in `EVIDENCE.md`.

## Verified local commands

- `bun test ...` focused continuation set: 28 passed, 0 failed, 139 expect calls; the original overhaul set remains recorded in `EVIDENCE.md`. The repair-attempt/migration continuation set is recorded separately there.
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
- `just fault-injection`: passed — 28 recovery tests, including DB-backed effect, repair, checkpoint-publication, and completion-admission scenarios; the artifact has 13 fixture-only boundaries, 7 DB-backed scenarios, and explicitly remains `completeForRelease: false`.

## Resume sequence

1. Inspect `git status --short --branch`, the last commit, and all four ledger files.
2. If the user authorizes remote branch-protection mutation, run `just github-ruleset-apply`, then `just github-ruleset-verify` and read back the exact remote settings.
3. Extend DB fault-injection/replay to proposal, branch admission, provider request identity, and cancellation boundaries; effect recovery, completion admission, coupled checkpoint/terminal publication, and repair continuation slices are covered, then later-state recovery remains before release readiness.

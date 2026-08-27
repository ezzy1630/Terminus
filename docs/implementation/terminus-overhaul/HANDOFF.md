# Terminus overhaul handoff

Read this file, `STATUS.md`, and the current Git diff before resuming.

## Current position

- Exact checkout: `/Volumes/Neural/Terminus`.
- Branch: `main`. The implementation and evidence ledger are clean at `d6fb7fb` (`Prove anonymous OpenCode Zen inference through kernel`); no push was performed.
- The worktree was clean before the ledger files and implementation changes were added. Other registered worktrees remain untouched.
- Durable ledger files live in `docs/implementation/terminus-overhaul/`.
- The implementation slice covers lifecycle ordering, recovery boundaries, cancellation, safe compaction, context instructions, provider stream/abort handling, anonymous OpenCode Zen free-model inference through the kernel, cumulative repair, default-off scout behavior, CI/ruleset declarations, evaluation-run contracts, and the Prisma DateTime upgrade migration.

## Remaining blockers

1. The live `main-protection` ruleset (id `21228252`) is weaker than the checked-in target. Applying it is a remote mutation and was not authorized.
2. Hosted CI/bootstrap, paid-account and alternate-provider live conformance, cross-platform sandbox enforcement, signed release artifacts, and private holdout evaluations are not proven locally. The anonymous OpenCode Zen free-model path is now proven; see `EVIDENCE.md`.
3. Recovery still quarantines rather than resumes `RESPONSE_VALIDATING`/`VERIFYING`; repair attempts lack a durable lease/parent record. Verification node IDs are now plan-scoped so a repair plan cannot collide with its parent in Prisma.
4. Automatic checkpoint failure is explicit but not atomic with terminal publication. Branch admission and completion-record persistence also remain separate crash boundaries.

## Safe working rules

- Do not reset, clean, rebase, merge, push, or touch the other worktrees.
- Use `apply_patch` for source edits.
- Keep provider requests, filesystem/process effects, and secrets behind the existing kernel boundary.
- Run focused tests after each slice. Run `just check`, `just codegen-check`, and applicable suites before claiming a gate.
- If a command is long or noisy, inspect its useful failing tail and record the exact status in `EVIDENCE.md`.

## Verified local commands

- `bun test ...` focused continuation set: 26 passed, 0 failed; the original overhaul set remains recorded in `EVIDENCE.md`.
- `bun test tests/persistence/migration_integrity.test.ts`: 4 passed, 0 failed, including legacy provider timestamp conversion with millisecond precision.
- `just codegen`: passed.
- `just codegen-check`: passed from committed `d6fb7fb`.
- `just check`: passed; existing clippy warnings and two generated-file ESLint warnings remain non-fatal.
- `just check-all`: passed from committed `d6fb7fb`; 583 TypeScript tests, 257 Python tests, full local Rust integration/security, platform-probe, and dependency-policy gates passed.
- `just standalone-check`: passed.
- `just truth-check`: passed.
- `just github-ruleset-plan`: passed read-only.
- `just github-ruleset-verify`: failed against the current weaker remote ruleset, as expected.

## Resume sequence

1. Inspect `git status --short --branch`, the last commit, and all four ledger files.
2. If the user authorizes remote branch-protection mutation, run `just github-ruleset-apply`, then `just github-ruleset-verify` and read back the exact remote settings.
3. Extend the durable repair-attempt/recovery and DB fault-injection slices before claiming release readiness.

# Terminus overhaul handoff

Read this file, `STATUS.md`, and the current Git diff before resuming.

## Current position

- Exact checkout: `/Volumes/Neural/Terminus`.
- Branch: `main`; the overhaul changes are currently uncommitted and must be reviewed and committed before the final handoff.
- The worktree was clean before the ledger files and implementation changes were added. Other registered worktrees remain untouched.
- Durable ledger files live in `docs/implementation/terminus-overhaul/`.
- The implementation slice covers lifecycle ordering, recovery boundaries, cancellation, safe compaction, context instructions, provider stream/abort handling, cumulative repair, default-off scout behavior, CI/ruleset declarations, and evaluation-run contracts.

## Remaining blockers

1. The live `main-protection` ruleset (id `21228252`) is weaker than the checked-in target. Applying it is a remote mutation and was not authorized.
2. Hosted CI/bootstrap, live provider inference, cross-platform sandbox enforcement, signed release artifacts, and private holdout evaluations are not proven locally.
3. Recovery still quarantines rather than resumes `RESPONSE_VALIDATING`/`VERIFYING`; repair attempts lack a durable lease/parent record.
4. Automatic checkpoint failure is explicit but not atomic with terminal publication. Branch admission and completion-record persistence also remain separate crash boundaries.

## Safe working rules

- Do not reset, clean, rebase, merge, push, or touch the other worktrees.
- Use `apply_patch` for source edits.
- Keep provider requests, filesystem/process effects, and secrets behind the existing kernel boundary.
- Run focused tests after each slice. Run `just check`, `just codegen-check`, and applicable suites before claiming a gate.
- If a command is long or noisy, inspect its useful failing tail and record the exact status in `EVIDENCE.md`.

## Verified local commands

- `bun test ...` focused overhaul set: 129 passed, 0 failed.
- `just codegen`: passed.
- `just check`: passed; existing clippy warnings and two generated-file ESLint warnings remain non-fatal.
- `just standalone-check`: passed.
- `just truth-check`: passed.
- `just github-ruleset-plan`: passed read-only.
- `just github-ruleset-verify`: failed against the current weaker remote ruleset, as expected.

## Resume sequence

1. Inspect `git diff --stat`, `git diff --check`, and all four ledger files.
2. Stage only task-owned paths, commit the coherent implementation, and run `just codegen-check` against that commit.
3. Run the focused tests and `just check` again if the diff changes.
4. If the user authorizes remote branch-protection mutation, run `just github-ruleset-apply`, then `just github-ruleset-verify` and read back the exact remote settings.
5. Extend the durable repair-attempt/recovery and DB fault-injection slices before claiming release readiness.

# Terminus overhaul evidence

This file records observed commands and artifacts. It does not turn source declarations, fixture responses, or test counts into product claims.

## Initial identity

| Field | Observed value |
| --- | --- |
| Checkout | `/Volumes/Neural/Terminus` |
| Branch | `main` |
| HEAD | `5f68925062cc3579e94c8e5f9a56b8b5ec46bfb9` |
| Worktree | clean at start |
| Other worktrees | `/Volumes/Neural/Terminus-audit-fixes`, `/Volumes/Neural/Terminus/.worktrees/p0-coding-loop` |
| Remote main | `5f68925062cc3579e94c8e5f9a56b8b5ec46bfb9` at initial inspection |

## Initial live-path observations

1. `mini-services/terminus-control/src/index.ts` enters `CONTEXT_COMPILING`, runs the extracted `CodingTurnEngine`, settles provider/tool episodes, and then emits `turn.finalizing` and `turn.completed`.
2. For task turns, verification begins after that terminal turn event and after `autoCommitTurnCheckpoint`.
3. `compileProviderContext` calls `runCompaction` with `contentJson: null` and artifact-derived byte sizes. The current compactor can prune rows despite lacking source text or an artifact reference in `EpisodeLike`.
4. `CodingTurnEngine` has a `doom_loop` result, but the live `switch` handles neither `doom_loop` nor a structured no-progress settlement. It later produces a generic no-final error.
5. `VerificationRepairController` is seeded from a durable event count, but `maxRepairAttempts` is calculated as configured maximum plus prior use, which can renew the task allowance on later turns.

## Post-implementation identity

| Field | Observed value |
| --- | --- |
| Implementation commit | `3a05ce6` (`Implement durable Terminus overhaul lifecycle gates`) |
| HEAD | `3840e82` (`Document overhaul evidence and handoff`) |
| Branch | `main` |
| Remote state | One commit ahead of `origin/main`; no push performed |
| Worktree | Clean after commit and `just codegen-check` |

## Current implementation observations

1. The live task path now emits `completion.proposed`, enters `VERIFYING`, persists verification artifacts, admits a candidate branch, atomically moves the task to `COMPLETED` and the turn to `VERIFIED`, then finalizes and publishes `turn.completed`.
2. A failed verification can enter `REPAIR_PENDING`, persist a cited repair directive and cumulative budget state, admit a repair-controller child turn, supersede the parent, and re-enter the same `agentLoop`; durable repair-attempt leases are still missing.
3. Recovery resumes only unambiguous pre-provider/context and settled-tool boundaries. Terminal-adjacent turns without a completion proposal artifact are quarantined as `FAILED`/`BLOCKED`; `RESPONSE_VALIDATING` and `VERIFYING` are not blindly replayed.
4. Compaction now refuses to hide a row unless body text and immutable artifact provenance are available, preserves source rows on summary failure/cancellation, and provides an atomic production commit callback.
5. Repository instructions are loaded through the kernel READ capability, converted to source-hashed required context fragments, and injected with scoped precedence. Scout execution is default-off and requires `TERMINUS_ENABLE_SCOUT=1`.
6. The live GitHub ruleset is active but weaker than the checked-in target: the current remote has zero required approvals, no code-owner requirement, and a repository-role bypass. The apply script remains dry-run by default.

## Commands run

| UTC time | Command | Result |
| --- | --- | --- |
| 2026-08-26 | `pwd; git status --short --branch; git rev-parse HEAD; git branch --all --verbose --no-abbrev; git worktree list --porcelain` | Passed. Exact checkout and clean `main` recorded above. |
| 2026-08-26 | `rg --files -g 'AGENTS.md' -g 'CLAUDE.md'` | Passed. Root and scoped package instructions inventoried. |
| 2026-08-26 | `rg -n` over control loop, compaction, provider, verification, and schema files | Passed. Live-path observations above confirmed. |
| 2026-08-26 | `bun test mini-services/terminus-control/src/agent-tools.test.ts mini-services/terminus-control/src/agent/coding-turn-engine.test.ts mini-services/terminus-control/src/agent/compaction-service.test.ts mini-services/terminus-control/src/agent/verification-repair-controller.test.ts mini-services/terminus-control/src/agent/scout-runner.test.ts mini-services/terminus-control/src/agent/subagents.test.ts mini-services/terminus-control/src/direct-provider-transport.test.ts mini-services/terminus-control/src/services/services.test.ts packages/context-compiler/src/context-compiler.test.ts packages/context-compiler/src/property-tests.test.ts packages/domain/src/state_machine_properties.test.ts` | PASSED — 129 tests, 0 failures, 1,669 expect calls. |
| 2026-08-26 | `just codegen` | PASSED — protobuf, public API, event, tool, config, v2 schema, SQLx, and generated docs completed. Expected generated docs/inventory changed with the source. |
| 2026-08-26 | `just codegen-check` | PASSED — generated paths are clean against the committed implementation. |
| 2026-08-26 | `just check` | PASSED — boundary checks, Rust fmt/clippy, ESLint (0 errors; 2 existing generated-file warnings), package/scripts/root TypeScript, and Python ruff/mypy. |
| 2026-08-26 | `just standalone-check` | PASSED — no retired OpenCode runtime/build dependency; explicit runtime-protocol -> public-api -> public-client chain. |
| 2026-08-26 | `just truth-check` | PASSED — CI triggers include the default branch and declarations agree with metadata. |
| 2026-08-26 | `bash -n scripts/apply-github-ruleset.sh && jq -e . .github/rulesets/main.json` | PASSED — local ruleset script syntax and JSON are valid. |
| 2026-08-26 | `just github-ruleset-plan` | PASSED — read-only plan resolved `ezzy1630/Terminus`, ruleset `main-protection`, id `21228252`; no remote mutation. |
| 2026-08-26 | `just github-ruleset-verify` | FAILED as intended for the current remote — live ruleset lacks required approval/code-owner settings and has a repository-role bypass. |
| 2026-08-26 | `bunx tsc --noEmit -p packages/context-compiler/tsconfig.json` | FAILED on the package-local baseline configuration (`bun:test`/rootDir/TS6307 cross-package test imports); root `just check` package typecheck passes. |
| 2026-08-26 | `bunx tsc --noEmit -p mini-services/terminus-control/tsconfig.json` | FAILED only on pre-existing control-project resolution issues: missing `@terminus/rollout`, missing `@terminus/cron`, and implicit `any` at `src/index.ts:3686`; changed-file paths added no new errors. |

## Evidence policy

- `PASSED` means the command exited successfully in this checkout and its relevant output was inspected.
- `FAILED` includes the exact failure class and useful tail.
- `BLOCKED` means an external credential, host, platform, or remote permission is required.
- `UNVERIFIED` means source or a partial local test suggests behavior but does not prove the acceptance condition.

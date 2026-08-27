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
| Ledger commits | `3840e82` (`Document overhaul evidence and handoff`), `f6c856d` (`Bind overhaul evidence to final handoff`) |
| HEAD at last evidence capture | `f6c856d` (`Bind overhaul evidence to final handoff`) |
| Branch | `main` |
| Remote state | Three commits ahead of `origin/main`; no push performed |
| Worktree | Clean at last evidence capture |

## Current implementation observations

1. The live task path now emits `completion.proposed`, enters `VERIFYING`, persists verification artifacts, admits a candidate branch, atomically moves the task to `COMPLETED` and the turn to `VERIFIED`, then finalizes and publishes `turn.completed`.
2. A failed verification can enter `REPAIR_PENDING`, persist a cited repair directive and cumulative budget state, admit a repair-controller child turn, supersede the parent, and re-enter the same `agentLoop`; durable repair-attempt leases are still missing.
3. Recovery resumes only unambiguous pre-provider/context and settled-tool boundaries. Terminal-adjacent turns without a completion proposal artifact are quarantined as `FAILED`/`BLOCKED`; `RESPONSE_VALIDATING` and `VERIFYING` are not blindly replayed.
4. Compaction now refuses to hide a row unless body text and immutable artifact provenance are available, preserves source rows on summary failure/cancellation, and provides an atomic production commit callback.
5. Repository instructions are loaded through the kernel READ capability, converted to source-hashed required context fragments, and injected with scoped precedence. Scout execution is default-off and requires `TERMINUS_ENABLE_SCOUT=1`.
6. The live GitHub ruleset is active but weaker than the checked-in target: the current remote has zero required approvals, no code-owner requirement, and a repository-role bypass. The apply script remains dry-run by default.
7. OpenCode Zen free-model execution now has a live end-to-end observation: anonymous model discovery, provider inference, response settlement, proposal, kernel-mediated verification, branch admission, and terminal completion all succeeded in one isolated stack.
8. The live run exposed and closed two runtime defects in the exercised path: source-only code-intelligence indexing prevents a normal repository refresh from exhausting the file budget, and repair plans now namespace verification node IDs. OpenCode gateway connectors have an explicit bounded 120-second timeout for model responses; the observed successful response settled after the prior 10-second default would have classified it as uncertain.

## Live OpenCode free-model evidence

This closes the live-provider proof for one supported anonymous public Zen path. It does not close paid-account, alternate-protocol, cache, retrieval, cross-platform, hosted-CI, or release gates.

| Surface | Observed evidence |
| --- | --- |
| Configuration | `PUT /v1/gateway-provider-config` admitted `deployment=zen`, `model=hy3-free`, `free_model=true`, `workspace_access=true`, and `credential_configured=false` at revision `1`, with the current Zen privacy-term identity. |
| Discovery | `GET /v1/provider-models` returned `hy3-free` as `provider=open_code_zen`, `free=true`, with `context_tokens=190000` and `output_tokens=64000`. The request used the explicit anonymous kernel connector. |
| Provider attempt | Task `74e8a44f-6333-4def-98da-2a10a843bfb3`, turn `4dc54750-1730-4236-931f-cd7c32a0e435`, and provider attempt `7a59c234-639f-49f5-805e-c98916b124a5` persisted `provider=open_code_zen`, `model=hy3-free`, `status=completed`, `cost_micros=0`, `inputTokens=1177`, and `outputTokens=893`. |
| Kernel receipt | The kernel recorded connector `opencode-gateway-anonymous` to `https://opencode.ai:443` with `status=200`, `outcome=Accepted`, `request_bytes=5863`, and `response_bytes=66967`. No credential header was injected. |
| Lifecycle | The same turn persisted `turn.response_validating`, `completion.proposed`, `turn.verifying`, `verification.admitted`, `turn.finalizing`, `context.auto_checkpoint_committed`, and `turn.completed`; the turn and task both ended `COMPLETED`. |
| Immutable response | The provider response was retained as `artifact://sha256/45cb876fa025ad457532eb2da20954deb6f4bf2f7ad8270369a1632d825a65a8`. The verification result was `pass` with its own immutable evidence artifact. |

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
| 2026-08-26 | `just check-all` | PASSED — `just check`, standalone and integration suites, 582 TypeScript tests, 257 Python tests, Rust integration/security tests, platform probes, and `cargo deny check`; 1 live conformance test remained ignored by its explicit network-test annotation. |
| 2026-08-26 | `just standalone-check` | PASSED — no retired OpenCode runtime/build dependency; explicit runtime-protocol -> public-api -> public-client chain. |
| 2026-08-26 | `just truth-check` | PASSED — CI triggers include the default branch and declarations agree with metadata. |
| 2026-08-26 | `bash -n scripts/apply-github-ruleset.sh && jq -e . .github/rulesets/main.json` | PASSED — local ruleset script syntax and JSON are valid. |
| 2026-08-26 | `just github-ruleset-plan` | PASSED — read-only plan resolved `ezzy1630/Terminus`, ruleset `main-protection`, id `21228252`; no remote mutation. |
| 2026-08-26 | `just github-ruleset-verify` | FAILED as intended for the current remote — live ruleset lacks required approval/code-owner settings and has a repository-role bypass. |
| 2026-08-26 | `bunx tsc --noEmit -p packages/context-compiler/tsconfig.json` | FAILED on the package-local baseline configuration (`bun:test`/rootDir/TS6307 cross-package test imports); root `just check` package typecheck passes. |
| 2026-08-26 | `bunx tsc --noEmit -p mini-services/terminus-control/tsconfig.json` | FAILED only on pre-existing control-project resolution issues: missing `@terminus/rollout`, missing `@terminus/cron`, and implicit `any` at `src/index.ts:3686`; changed-file paths added no new errors. |
| 2026-08-26 | `bun test mini-services/terminus-control/src/verification-runtime.test.ts mini-services/terminus-control/src/gateway-provider-config.test.ts packages/provider-zen/src/transport.test.ts mini-services/terminus-control/src/gateway-kernel-client.test.ts` | PASSED — 22 tests, 0 failures, 56 expect calls. |
| 2026-08-26 | `cargo test --manifest-path crates/terminus-code-intel/Cargo.toml` | PASSED — 12 tests, 0 failures. Covers dependency/generated-tree, oversized-file, non-source, binary, and semantic indexing behavior. |
| 2026-08-26 | `cargo test --manifest-path crates/terminus-connector/Cargo.toml --test broker_e2e anonymous_connector_is_explicitly_registered` | PASSED — explicit anonymous connector registration and credential-mode classification. |
| 2026-08-26 | `cargo build --release --manifest-path mini-services/terminus-kernel/Cargo.toml` | PASSED — release kernel rebuilt from the current checkout with anonymous OpenCode routing and the per-connector model timeout. |
| 2026-08-26 | Isolated fresh kernel/control stack: configure `hy3-free`, refresh discovery, submit a task, poll the public turn/task projections, and read back SQLite plus kernel logs | PASSED — live anonymous Zen inference settled through the kernel and the full task completed; exact evidence is recorded above. |

## Evidence policy

- `PASSED` means the command exited successfully in this checkout and its relevant output was inspected.
- `FAILED` includes the exact failure class and useful tail.
- `BLOCKED` means an external credential, host, platform, or remote permission is required.
- `UNVERIFIED` means source or a partial local test suggests behavior but does not prove the acceptance condition.

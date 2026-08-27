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
| Implementation commits | `3a05ce6` (`Implement durable Terminus overhaul lifecycle gates`), `d6fb7fb` (`Prove anonymous OpenCode Zen inference through kernel`), `327444f` (`Persist repair attempts and fenced recovery leases`), `ad9b458` (`Add database-backed repair recovery replay tests`), `a592cea` (`Add database-backed checkpoint replay tests`), `0c3a98a` (`Persist completion admission across recovery`), `ebf4344` (`Fix completion record scope at admission`), `7e66f2f` (`Make checkpoint and terminal publication atomic`), `a163d40` (`Record atomic checkpoint publication evidence`), `5f6a803` (`Make ambiguous effect recovery atomic and replay-safe`), `8983439` (`Persist provider attempt identity and response metadata`), `4316ad1` (`Fail closed on in-flight provider recovery`), `a76eb86` (`Make task cancellation atomic and replay-safe`), `a1c794c` (`Fence candidate branch admission across recovery`) |
| Ledger commits | `3840e82` (`Document overhaul evidence and handoff`), `f6c856d` (`Bind overhaul evidence to final handoff`), `8543df6` (`Finalize overhaul verification ledger`), `0c3a98a` (`Persist completion admission across recovery`), `e0a9fda` (`Bind completion recovery evidence to current tree`), `91c377f` (`Finalize current-tree evidence identity`) |
| HEAD at last implementation evidence capture | `a1c794c` (`Fence candidate branch admission across recovery`) |
| Branch | `main` |
| Remote state at last implementation evidence capture | Twenty-six commits ahead of `origin/main`; no push performed |
| Functional worktree | Clean at the `a1c794c` functional checkpoint; the ledger update is committed separately |

## Current implementation observations

1. The live task path now emits `completion.proposed`, enters `VERIFYING`, persists verification artifacts, admits a candidate branch, atomically moves the task to `COMPLETED` and the turn to `VERIFIED`, then finalizes and publishes `turn.completed`.
2. A failed verification can enter `REPAIR_PENDING`, persist a cited repair directive and cumulative budget state, admit a repair-controller child turn, supersede the parent, and re-enter the same `agentLoop`; migration `0012_repair_attempts` now makes the attempt identity, parent/child association, provenance, budget, and fencing lease durable.
3. Recovery resumes only unambiguous pre-provider/context and settled-tool boundaries. Terminal-adjacent turns without a completion proposal artifact are quarantined as `FAILED`/`BLOCKED`; `RESPONSE_VALIDATING` and `VERIFYING` are not blindly replayed.
4. Compaction now refuses to hide a row unless body text and immutable artifact provenance are available, preserves source rows on summary failure/cancellation, and provides an atomic production commit callback.
5. Repository instructions are loaded through the kernel READ capability, converted to source-hashed required context fragments, and injected with scoped precedence. Scout execution is default-off and requires `TERMINUS_ENABLE_SCOUT=1`.
6. The live GitHub ruleset is active but weaker than the checked-in target: the current remote has zero required approvals, no code-owner requirement, and a repository-role bypass. The apply script remains dry-run by default.
7. OpenCode Zen free-model execution now has a live end-to-end observation: anonymous model discovery, provider inference, response settlement, proposal, kernel-mediated verification, branch admission, and terminal completion all succeeded in one isolated stack.
8. The live run exposed and closed two runtime defects in the exercised path: source-only code-intelligence indexing prevents a normal repository refresh from exhausting the file budget, and repair plans now namespace verification node IDs. OpenCode gateway connectors have an explicit bounded 120-second timeout for model responses; the observed successful response settled after the prior 10-second default would have classified it as uncertain.
9. Migration `0011_prisma_datetime_storage.sql` rebuilds the two Prisma-owned provider tables with strict integer epoch-millisecond timestamps. An upgrade fixture proved legacy ISO timestamps, including fractional seconds, preserve their exact millisecond values.
10. Durable repair recovery now owns the crash windows between schedule, parent transition, child admission, and execution. A live lease blocks duplicate claims; an expired lease increments its fencing token; heartbeats abort a continuation after lease loss; and a restarted control process schedules a retry after a stale lease expires. A `VERIFYING` parent with an already-persisted repair attempt is left for this recovery path instead of being generically quarantined.
11. A DB-backed recovery test now exercises three of those boundaries against a fresh database migrated through `0012_repair_attempts`: schedule intent and its event roll back together, parent/child admission replays without duplicate rows/events, and a stale repair claimant cannot settle after lease fencing. The release artifact labels the remaining in-memory matrix as fixture-only and records `completeForRelease: false`.
12. A second DB-backed recovery test exercises checkpoint publication against the same fresh-migration discipline: a crash before publication commit leaves the checkpoint `PREPARED` with no event, duplicate artifact linking collapses through the uniqueness constraint, and repeated recovery leaves one `COMMITTED` row with one `checkpoint.created` event.
13. Completion admission now persists an immutable `PREPARED` record before candidate-branch admission and flips it to `COMMITTED` in the same transaction as task completion, the verified-turn transition, and `task.completed`. Startup only replays that transition when the associated branch is already `ADMITTED`; otherwise it quarantines the intent. A fresh-migration DB test proves rollback of all four rows/events, replay without a provider attempt, and quarantine of an open branch.
14. Successful automatic checkpoint admission now shares one writer transaction with `checkpoint.created`, `context.auto_checkpoint_committed`, `turn.completed`, checkpoint `COMMITTED` state, and turn `COMPLETED` state. Startup validates a prepared checkpoint first, then defers a row tied to a completed task and terminal-adjacent turn so recovery can commit that coupled boundary together. Fresh-migration tests cover rollback and idempotent replay of the checkpoint and terminal publication batch.
15. Restart recovery now enumerates `STARTED`, `UNKNOWN`, and `RECONCILING` side effects before active-turn recovery. For each row it records `tool.settlement_unknown` with `effect-recovery:<side-effect-id>`, updates the linked tool call to `UNKNOWN` and the effect to `MANUAL_REVIEW` in the same writer transaction, and never retries the external operation. A settled effect is skipped without contradictory evidence, and recovery failures make startup fail closed.
16. Provider-attempt identity is now durable beyond attempt number: the control plane derives a fingerprint from the exact request artifact hash, provider/model snapshot hash, admitted endpoint, tool-schema hash, immutable context epoch, and attempt ID. The same identity is written to the provider-running event and `provider_attempts` row with a unique kernel idempotency key; provider-native request IDs and continuation IDs are stored in typed columns when the stream exposes them. A fresh-migration DB test proves atomic publication rollback and duplicate-key rejection. This does not claim provider-level deduplication for endpoints that do not support it.
17. Startup and explicit recovery now enumerate in-flight provider attempts before active-turn recovery. An attempt without a durable response is atomically marked `interrupted`, its active turn is marked `INTERRUPTED`, its active task is `BLOCKED`, and `turn.recovery_interrupted` carries the request identity and reconciliation requirement. A failed transaction leaves all rows and the event unchanged; replay after commit finds no in-flight attempt and emits no second recovery event. No provider request is retried automatically.
18. Task cancellation now reads active and `REPAIR_PENDING` turns under the mutation lock, emits one idempotent `turn.aborted` event per turn plus `task.aborted`, CASes every turn and the task to terminal `ABORTED` state in the same transaction, and only then signals in-process abort controllers. A fresh-migration DB test proves rollback leaves every row and event unchanged, while committed cancellation replays without duplicate abort events.
19. Candidate-branch admission now advances `OPEN` to durable `ADMITTING` before the external merge boundary. Startup and explicit recovery never turn that state back into `OPEN`; without a trusted merge receipt they atomically emit `candidate_branch.recovery_manual_review`, move the branch to `MANUAL_REVIEW`, and block the active task. A fresh-migration DB test proves rollback, one-event replay, stable idempotency, and that an already `ADMITTED` branch is not rescanned. Trusted external merge-receipt reconciliation remains open.

## Durable repair-attempt evidence

Migration `0012_repair_attempts.sql` and the Prisma model persist one row per
task-level repair attempt. The row references the parent and optional repair
child turns, stores the directive/failure/source/environment/budget evidence,
and owns a unique `leases` row. Focused unit tests cover stable lease identity,
live-owner exclusion, fencing-token increment on expiry, missing/terminal
attempt rejection, and terminal settlement classification. The migration
integrity test applies all migrations, reads the new columns through SQLite,
checks the lease association, and rejects duplicate task/attempt numbers.

This is implementation evidence for durable identity and recovery scheduling,
not proof of the full D3 metric suite or the B2 fault-injection/replay matrix.
The DB-backed scenarios are in
`tests/recovery/repair_attempt_recovery.test.ts`; the broader matrix in
`tests/recovery/fault_injection_matrix.test.ts` remains an in-memory fixture
suite and is labeled that way in `fault-injection.json`.
Checkpoint publication coverage is in
`tests/recovery/checkpoint_publication_recovery.test.ts`. It covers the
`PREPARED`/`COMMITTED` admission boundary, artifact-link uniqueness, and the
coupled checkpoint/terminal publication transaction.

Completion admission coverage is in
`tests/recovery/completion_admission_recovery.test.ts`. Migration
`0013_completion_admission.sql` adds the durable state and candidate-branch
association. The test proves that an admitted branch can replay completion
without provider inference, while an unadmitted branch is quarantined. This
closes the branch/record crash window but not the broader provider/effect or
later-state recovery requirements.

External-effect recovery coverage is in `tests/recovery/effect_recovery.test.ts`.
It uses a fresh migrated SQLite database to prove rollback of the unknown
event plus tool/effect state, one-event replay into `UNKNOWN`/`MANUAL_REVIEW`,
and no recovery event for an already-settled effect. The production recovery
helper runs at bootstrap and at `POST /v1/system/recover`; it has no trusted
kernel receipt query for this legacy v1 effect ledger, so the safe outcome is
manual review rather than a blind retry.

## Provider-attempt identity evidence

Migration `0014_provider_attempt_identity.sql` adds nullable legacy-compatible
columns for the request fingerprint, kernel idempotency key, provider request
ID, and continuation ID. New attempts require the first two through the
control-plane writer, and a partial unique index prevents a durable replay from
creating a second attempt with the same kernel key. The exact request body
remains in the content-addressed artifact store; the operational row records
its hash rather than duplicating provider-specific bytes.

Coverage is in `tests/recovery/provider_attempt_identity.test.ts`. It proves
canonical fingerprint stability and sensitivity to every identity component,
transaction rollback before publication, typed metadata read-back, and unique
idempotency-key enforcement on a fresh migrated SQLite database. Provider
stream tests cover OpenAI Responses/Chat Completions, Anthropic Messages, and
Zen Chat Completions/Responses/Messages native IDs.

Provider-attempt recovery coverage is in
`tests/recovery/provider_attempt_recovery.test.ts`. It uses a fresh migrated
SQLite database to prove rollback of the event, attempt, turn, and task
changes; committed interruption/blocking with identity-bearing recovery
evidence; replay without a second event; and no recovery evidence for an
already-settled attempt. The production bootstrap and `POST /v1/system/recover`
paths run this reconciliation before active-turn recovery.

## Proposal and cancellation recovery evidence

`tests/recovery/proposal_cancellation_recovery.test.ts` uses a fresh migrated
SQLite database to cover two previously separate boundaries. A completion
proposal remains non-terminal: publication rollback leaves no event, and a
restart quarantines unsafe `RESPONSE_VALIDATING` work without creating a
completion record. Cancellation is tested as one transaction across two active
turns, the task row, and three abort events; injected failure rolls back all of
them, while committed cancellation is idempotent and replay emits no second
set of events. These tests model the production writer transaction and do not
claim provider inference or external branch-merge proof.

## Candidate-branch admission recovery evidence

Migration `0015_candidate_branch_admission_recovery.sql` adds the durable
`ADMITTING` and `MANUAL_REVIEW` candidate-branch states while preserving
existing rows and the task/status index. The runtime protocol and event
catalog define the replay-safe `candidate_branch.recovery_manual_review`
event. The live Prisma, SQLite, and in-memory adapters mark a successful
claim as `ADMITTING`; recovery then uses an epoch compare-and-swap to move it
to `MANUAL_REVIEW` and block an active or verifying task in the same writer
transaction. No merge is retried because the current adapter has no trusted
external merge-receipt query.

`tests/recovery/branch_admission_recovery.test.ts` proves the injected
rollback leaves the branch, task, and event unchanged; committed recovery
creates exactly one manual-review event and is replay-safe; and a durably
`ADMITTED` branch is untouched. The fault-injection artifact records this as
`branch_admission_recovery_replay` at the
`after_external_merge_before_receipt` boundary. This is DB-backed local
evidence, not proof of a real remote merge receipt or release completeness.

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
| 2026-08-26 | `bun test mini-services/terminus-control/src/services/services.test.ts tests/recovery/repair_attempt_recovery.test.ts tests/recovery/checkpoint_publication_recovery.test.ts tests/recovery/completion_admission_recovery.test.ts tests/recovery/effect_recovery.test.ts tests/persistence/migration_integrity.test.ts` | PASSED — 28 tests, 0 failures, 139 expect calls; includes atomic unknown-effect recovery, replay/no-duplicate evidence, repair fencing, completion admission, coupled checkpoint/terminal publication, and migration coverage. |
| 2026-08-26 | `just codegen` | PASSED — event catalog regenerated to 50 events, including `tool.settlement_unknown`; generated docs and indexes were committed with `5f6a803`. |
| 2026-08-26 | `just codegen-check` from committed `5f6a803` | PASSED — generated protobuf, API, event, tool, config, schema, SQLx, and documentation outputs are stable. |
| 2026-08-26 | `just fault-injection` | PASSED — the artifact records 13 `fixture_only` boundaries, 7 DB-backed scenarios, and `completeForRelease: false`; `effect_recovery_replay` now covers the ambiguous effect recovery transaction. |
| 2026-08-26 | `bun test mini-services/terminus-control/src/services/services.test.ts mini-services/terminus-control/src/agent/coding-turn-engine.test.ts packages/provider-openai/src/openai_responses.test.ts packages/provider-anthropic/src/anthropic_messages.test.ts packages/provider-zen/src/transport.test.ts tests/recovery/provider_attempt_identity.test.ts tests/persistence/migration_integrity.test.ts` | PASSED — 37 tests, 0 failures, 183 expect calls; includes provider-session identity propagation, native response-ID decoding, fresh-migration provider-attempt rollback/read-back/duplicate-key coverage, and migration integrity. |
| 2026-08-26 | `bunx prisma generate` | PASSED — the generated Prisma client reflects the nullable provider-attempt identity and response metadata columns. |
| 2026-08-26 | `just codegen-check` from committed `8983439` | PASSED — generated protobuf, API, event, tool, config, schema, SQLx, and documentation outputs are stable, including migration `0014_provider_attempt_identity`. |
| 2026-08-26 | `just fault-injection` from committed `8983439` | PASSED — the artifact records 13 `fixture_only` boundaries, 8 DB-backed scenarios, 29 passing recovery tests, and `completeForRelease: false`; `provider_attempt_identity_replay` covers atomic identity publication and duplicate-key rejection. |
| 2026-08-26 | `just check-all` from committed `8983439` | PASSED — the full local check-all command exited 0; the final cargo-deny tail reported `advisories ok, bans ok, licenses ok, sources ok`. |
| 2026-08-26 | `bun test mini-services/terminus-control/src/services/services.test.ts mini-services/terminus-control/src/agent/coding-turn-engine.test.ts packages/provider-openai/src/openai_responses.test.ts packages/provider-anthropic/src/anthropic_messages.test.ts packages/provider-zen/src/transport.test.ts tests/recovery/provider_attempt_identity.test.ts tests/recovery/provider_attempt_recovery.test.ts tests/recovery/repair_attempt_recovery.test.ts tests/recovery/checkpoint_publication_recovery.test.ts tests/recovery/completion_admission_recovery.test.ts tests/recovery/effect_recovery.test.ts tests/persistence/migration_integrity.test.ts` | PASSED — 53 tests, 0 failures, 262 expect calls; includes all current provider, lifecycle, migration, and DB-backed recovery slices. |
| 2026-08-26 | `just fault-injection` from committed `4316ad1` | PASSED — the artifact records 13 `fixture_only` boundaries, 9 DB-backed scenarios, 32 passing recovery tests, and `completeForRelease: false`; `provider_attempt_recovery_replay` covers no-duplicate in-flight provider recovery. |
| 2026-08-26 | `bun run typecheck` from committed `4316ad1` | PASSED — root TypeScript typecheck completed with no diagnostics. |
| 2026-08-26 | `just codegen-check` from committed `4316ad1` | PASSED — generated outputs remain stable after the recovery implementation. |
| 2026-08-26 | `just check-all` from committed `4316ad1` | PASSED — the full local check-all command exited 0; the final cargo-deny tail reported `advisories ok, bans ok, licenses ok, sources ok`. |
| 2026-08-26 | `bun test tests/recovery/proposal_cancellation_recovery.test.ts` from committed `a76eb86` | PASSED — 3 tests, 0 failures, 22 expect calls; proposal remains non-terminal and cancellation rollback/replay is atomic and idempotent. |
| 2026-08-26 | `just fault-injection` from committed `a76eb86` | PASSED — the artifact records 13 `fixture_only` boundaries, 11 DB-backed scenarios, 35 passing recovery tests, and `completeForRelease: false`; proposal recovery and task cancellation replay are included. |
| 2026-08-26 | `bun run typecheck` from committed `a76eb86` | PASSED — root TypeScript typecheck completed with no diagnostics. |
| 2026-08-26 | `just codegen-check` from committed `a76eb86` | PASSED — generated outputs remain stable after the cancellation implementation. |
| 2026-08-26 | `just check` from committed `a76eb86` | PASSED — boundary checks, Rust fmt/clippy, ESLint (0 errors; 2 existing generated-file warnings), package/scripts/root TypeScript, and Python ruff/mypy. |
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
| 2026-08-26 | `bun install --frozen-lockfile` | PASSED — 1,034 installs checked with no lockfile changes. |
| 2026-08-26 | `bun test mini-services/terminus-control/src/verification-runtime.test.ts mini-services/terminus-control/src/gateway-provider-config.test.ts mini-services/terminus-control/src/gateway-kernel-client.test.ts packages/provider-zen/src/transport.test.ts tests/persistence/migration_integrity.test.ts` | PASSED — 26 tests, 0 failures, 82 expect calls. |
| 2026-08-26 | `cargo test --manifest-path crates/terminus-connector/Cargo.toml --test broker_e2e` | PASSED — 13 tests, 0 failures; 1 explicitly ignored invalid-credential public canary. |
| 2026-08-26 | `bun test tests/persistence/migration_integrity.test.ts` | PASSED — migration ledger, strict DateTime upgrade, rollback, and corruption tests: 4 tests, 0 failures. |
| 2026-08-26 | `bun test mini-services/terminus-control/src/services/repair-attempt-store.test.ts mini-services/terminus-control/src/services/services.test.ts tests/persistence/migration_integrity.test.ts` | PASSED — 20 tests, 0 failures, 81 expect calls; includes durable repair claim/settlement helpers, coordinator transaction persistence, and migration read-back/uniqueness checks. |
| 2026-08-26 | `bunx prisma validate --schema prisma/schema.prisma` | PASSED — Prisma schema validates with the `RepairAttempt` relations and migration-backed fields. |
| 2026-08-26 | `DATABASE_URL=file:<temporary> bun run scripts/migrate.ts` plus a Prisma `repairAttempt.count()` read-back | PASSED — migrations 001–012 applied, integrity check passed, and the generated client queried `repair_attempts`. The temporary database was outside the repository. |
| 2026-08-26 | `just codegen-check` from committed `d6fb7fb` | PASSED — generated paths are clean against the exact committed tree. |
| 2026-08-26 | `just check` from committed `d6fb7fb` | PASSED — boundary checks, Rust fmt/clippy, ESLint (0 errors; 2 existing generated-file warnings), package/scripts/root TypeScript, and Python ruff/mypy. |
| 2026-08-26 | `just check-all` from committed `d6fb7fb` | PASSED — 583 TypeScript tests across 82 files, 257 Python tests, Rust integration/security tests, platform probes, standalone/truth checks, generated-contract check, and `cargo deny`; 1 live conformance test remained ignored by its explicit network-test annotation. |
| 2026-08-26 | `just codegen-check` from committed `327444f` | PASSED — generated protobuf, API, event, tool, config, schema, SQL migration inventory, and documentation outputs are stable against the repair-persistence commit. |
| 2026-08-26 | `just check` from committed `327444f` | PASSED — boundary checks, Rust fmt/clippy, ESLint (0 errors; 2 existing generated-file warnings), package/scripts/root TypeScript, and Python ruff/mypy. |
| 2026-08-26 | `just check-all` from committed `327444f` | PASSED — 583 TypeScript tests across 82 files, 257 Python tests, full local Rust integration/security, platform probes, standalone/truth checks, generated-contract check, and `cargo deny`; 1 live conformance test remained ignored by its explicit network-test annotation. |
| 2026-08-26 | `bun test tests/recovery/repair_attempt_recovery.test.ts` | PASSED — 3 DB-backed SQLite recovery tests, 0 failures, 17 expect calls. |
| 2026-08-26 | `bun test tests/recovery/fault_injection_matrix.test.ts tests/recovery/repair_attempt_recovery.test.ts` | PASSED — 17 tests, 0 failures, 97 expect calls; the 13-boundary in-memory matrix and the 3 DB-backed repair scenarios both executed. |
| 2026-08-26 | `bun test tests/recovery/checkpoint_publication_recovery.test.ts` | PASSED — 2 DB-backed SQLite checkpoint recovery tests, 0 failures, 7 expect calls. |
| 2026-08-26 | `bun test tests/recovery/fault_injection_matrix.test.ts tests/recovery/repair_attempt_recovery.test.ts tests/recovery/checkpoint_publication_recovery.test.ts` | PASSED — 19 tests, 0 failures, 104 expect calls; the fixture matrix, repair replay, and checkpoint publication suites all executed. |
| 2026-08-26 | `just fault-injection` | PASSED — `artifacts/release-gate/fault-injection.json` was regenerated from all three recovery test files; it records 13 `fixture_only` boundaries, 4 DB-backed scenarios, and `completeForRelease: false`. |
| 2026-08-26 | `bunx prisma validate --schema prisma/schema.prisma` | PASSED — the completion admission fields and nullable candidate-branch association validate in the Prisma schema. |
| 2026-08-26 | `bun test mini-services/terminus-control/src/services/services.test.ts tests/recovery/completion_admission_recovery.test.ts tests/persistence/migration_integrity.test.ts` | PASSED — 18 tests, 0 failures, 91 expect calls; includes coordinator propagation, fresh-migration completion rollback/replay/quarantine, and migration read-back. |
| 2026-08-26 | `just fault-injection` | PASSED — the artifact was regenerated from four recovery test files; it records 13 `fixture_only` boundaries, 5 DB-backed scenarios, 22 passing tests, and `completeForRelease: false`. |
| 2026-08-26 | `just codegen-check` from committed `ebf4344` | PASSED — generated protobuf, API, event, tool, config, schema, SQL migration inventory, and documentation outputs are stable with migration `0013_completion_admission`. |
| 2026-08-26 | `just check-all` from committed `ebf4344` | PASSED — 583 TypeScript unit tests, 257 Python tests, 281 integration tests, Rust workspace libraries/tests, standalone/truth checks, platform probes, security suites, and `cargo deny`; one public OpenCode TLS canary remained explicitly ignored. |
| 2026-08-26 | `just fault-injection` from committed `ebf4344` | PASSED — 22 recovery tests, 13 `fixture_only` boundaries, 5 DB-backed scenarios, and `completeForRelease: false`. |
| 2026-08-26 | `bun test mini-services/terminus-control/src/services/services.test.ts tests/recovery/repair_attempt_recovery.test.ts tests/recovery/checkpoint_publication_recovery.test.ts tests/recovery/completion_admission_recovery.test.ts tests/persistence/migration_integrity.test.ts` | PASSED — 25 tests, 0 failures, 123 expect calls; includes repair, completion-admission, coupled checkpoint/terminal publication rollback/replay, and migration coverage. |
| 2026-08-26 | `just fault-injection` | PASSED — the artifact records 13 `fixture_only` boundaries, 6 DB-backed scenarios, 24 passing recovery tests, and `completeForRelease: false`; the new scenario covers coupled checkpoint and terminal publication. |
| 2026-08-26 | `just check` | PASSED — boundary checks, Rust fmt/clippy, ESLint (0 errors; 2 existing generated-file warnings), package/scripts/root TypeScript, and Python ruff/mypy. |
| 2026-08-26 | `bun test packages/runtime-protocol/src/v2_protocol.test.ts` | PASSED — 6 tests, 0 failures, 19 expect calls. |
| 2026-08-26 | `bun test packages/task-runtime/src/effects.test.ts tests/recovery/branch_admission_recovery.test.ts tests/recovery/proposal_cancellation_recovery.test.ts` | PASSED — 29 tests, 0 failures, 90 expect calls; admission receives `ADMITTING`, branch recovery rolls back/replays, and proposal/cancellation recovery remains green. |
| 2026-08-26 | `bun test tests/persistence/migration_integrity.test.ts` | PASSED — 5 tests, 0 failures, 33 expect calls; all migrations including `0015_candidate_branch_admission_recovery.sql` apply and integrity checks pass. |
| 2026-08-26 | `bun run typecheck` | PASSED — root TypeScript typecheck completed with no diagnostics after the branch-admission state/event additions. |
| 2026-08-26 | `just codegen-check` after `a1c794c` | PASSED — generated protobuf, API, event, tool, config, schema, SQLx, and documentation outputs are stable with the 51-event catalog and 15-migration inventory. |
| 2026-08-26 | `just check` after `a1c794c` | PASSED — boundary checks, Rust fmt/clippy, ESLint (0 errors; 2 existing generated-file warnings), package/scripts/root TypeScript, and Python ruff/mypy. |
| 2026-08-26 | `just check-all` after `a1c794c` | PASSED — 583 TypeScript tests, 257 Python tests, 281 integration tests, 5 grader-integration tests, Rust libraries/integration/security tests, platform probes, standalone/truth checks, and `cargo deny`; one explicitly ignored live conformance canary remains. |
| 2026-08-26 | `git diff --check` | PASSED — no whitespace errors in the pending evidence-ledger update. |
| 2026-08-26 | `just fault-injection` from committed `a1c794c` | PASSED — the artifact records 13 `fixture_only` boundaries, 12 DB-backed scenarios, 37 passing recovery tests, and `completeForRelease: false`; `branch_admission_recovery_replay` covers the external-merge/receipt boundary. |

## Evidence policy

- `PASSED` means the command exited successfully in this checkout and its relevant output was inspected.
- `FAILED` includes the exact failure class and useful tail.
- `BLOCKED` means an external credential, host, platform, or remote permission is required.
- `UNVERIFIED` means source or a partial local test suggests behavior but does not prove the acceptance condition.

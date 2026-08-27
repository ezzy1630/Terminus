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
| Implementation commits | `3a05ce6` (`Implement durable Terminus overhaul lifecycle gates`), `d6fb7fb` (`Prove anonymous OpenCode Zen inference through kernel`), `327444f` (`Persist repair attempts and fenced recovery leases`), `ad9b458` (`Add database-backed repair recovery replay tests`), `a592cea` (`Add database-backed checkpoint replay tests`), `0c3a98a` (`Persist completion admission across recovery`), `ebf4344` (`Fix completion record scope at admission`), `7e66f2f` (`Make checkpoint and terminal publication atomic`), `a163d40` (`Record atomic checkpoint publication evidence`), `5f6a803` (`Make ambiguous effect recovery atomic and replay-safe`), `8983439` (`Persist provider attempt identity and response metadata`), `4316ad1` (`Fail closed on in-flight provider recovery`), `a76eb86` (`Make task cancellation atomic and replay-safe`), `a1c794c` (`Fence candidate branch admission across recovery`), `d3760b1` (`Resume verification safely after control-plane restart`), `ea7f34a` (`Keep verification recovery provider-free`), `c04ff58` (`Test verification resume rejection paths`), `a42acc5` (`Derive verification plans from task signals`), `c94f7fd` (`Expose durable repair metrics`), `2cb2976` (`Aggregate durable repair metrics for ops evidence`), `09b9d38` (`Persist exact provider cost accounting`), `6850036` (`Wire revisioned repository maps and native recipe discovery`), `8a2923d` (`Consume revisioned repository map continuations`), `410685f` (`Measure and ablate retrieval selection`), `050115f` (`Persist realized cache observations`), `b693ddb` (`Add fail-closed governed UI verification predicate`), `69ffb70` (`Fix Prisma provider timestamp migration`), `c56e245` (`Add trusted candidate merge receipt recovery`) |
| Ledger commits | `3840e82` (`Document overhaul evidence and handoff`), `f6c856d` (`Bind overhaul evidence to final handoff`), `8543df6` (`Finalize overhaul verification ledger`), `0c3a98a` (`Persist completion admission across recovery`), `e0a9fda` (`Bind completion recovery evidence to current tree`), `91c377f` (`Finalize current-tree evidence identity`), `611c199` (`Record repository map continuation evidence`), `a81bddd` (`Record governed UI verification evidence`), `5847996` (`Record fresh live cache evidence`), `8f2bd08` (`Record cache cohort threshold evidence`), `89ef858` (`Bind cache cohort evidence to ledger`) |
| HEAD at last implementation evidence capture | `c56e245` (`Add trusted candidate merge receipt recovery`) |
| Branch | `main` |
| Remote state at last implementation evidence capture | Fifty-seven commits ahead of `origin/main`; no push performed |
| Functional worktree | Functional paths are clean at `c56e245`; `SPEC.md` retains a pre-existing user edit |

## Current implementation observations

1. The live task path now emits `completion.proposed`, enters `VERIFYING`, persists verification artifacts, admits a candidate branch, atomically moves the task to `COMPLETED` and the turn to `VERIFIED`, then finalizes and publishes `turn.completed`.
2. A failed verification can enter `REPAIR_PENDING`, persist a cited repair directive and cumulative budget state, admit a repair-controller child turn, supersede the parent, and re-enter the same `agentLoop`; migration `0012_repair_attempts` now makes the attempt identity, parent/child association, provenance, budget, and fencing lease durable.
3. Recovery resumes only unambiguous pre-provider/context, settled-tool, and verification boundaries. Terminal-adjacent turns without a completion proposal artifact are quarantined as `FAILED`/`BLOCKED`; `RESPONSE_VALIDATING` and `VERIFYING` now reuse a durable response artifact and exact persisted verification identity, while stale or legacy state fails closed.
4. Compaction now refuses to hide a row unless body text and immutable artifact provenance are available, preserves source rows on summary failure/cancellation, and provides an atomic production commit callback.
5. Repository instructions are loaded through the kernel READ capability, converted to source-hashed required context fragments, and injected with scoped precedence. Scout execution is default-off and requires `TERMINUS_ENABLE_SCOUT=1`.
6. The live GitHub ruleset is active but weaker than the checked-in target: the current remote has zero required approvals, no code-owner requirement, and a repository-role bypass. The apply script remains dry-run by default.
7. OpenCode Zen free-model execution now has a live end-to-end observation: anonymous model discovery, provider inference, response settlement, proposal, kernel-mediated verification, branch admission, and terminal completion all succeeded in one isolated stack.
8. The live run exposed and closed two runtime defects in the exercised path: source-only code-intelligence indexing prevents a normal repository refresh from exhausting the file budget, and repair plans now namespace verification node IDs. OpenCode gateway connectors have an explicit bounded 120-second timeout for model responses; the observed successful response settled after the prior 10-second default would have classified it as uncertain.
9. Migration `0011_prisma_datetime_storage.sql` historically rebuilt the two Prisma-owned provider tables with strict `INTEGER` epoch-millisecond timestamps. A fresh control-plane write then exposed the current-epoch overflow (`Value 1787856102551 does not fit in an INT column`); migration `0018_provider_datetime_bigint.sql` rebuilds both tables with Prisma-compatible `BIGINT` declarations while preserving legacy values.
10. Durable repair recovery now owns the crash windows between schedule, parent transition, child admission, and execution. A live lease blocks duplicate claims; an expired lease increments its fencing token; heartbeats abort a continuation after lease loss; and a restarted control process schedules a retry after a stale lease expires. A `VERIFYING` parent with an already-persisted repair attempt is left for this recovery path instead of being generically quarantined.
11. A DB-backed recovery test now exercises three of those boundaries against a fresh database migrated through `0012_repair_attempts`: schedule intent and its event roll back together, parent/child admission replays without duplicate rows/events, and a stale repair claimant cannot settle after lease fencing. The release artifact labels the remaining in-memory matrix as fixture-only and records `completeForRelease: false`.
12. A second DB-backed recovery test exercises checkpoint publication against the same fresh-migration discipline: a crash before publication commit leaves the checkpoint `PREPARED` with no event, duplicate artifact linking collapses through the uniqueness constraint, and repeated recovery leaves one `COMMITTED` row with one `checkpoint.created` event.
13. Completion admission now persists an immutable `PREPARED` record before candidate-branch admission and flips it to `COMMITTED` in the same transaction as task completion, the verified-turn transition, and `task.completed`. Startup only replays that transition when the associated branch is already `ADMITTED`; otherwise it quarantines the intent. A fresh-migration DB test proves rollback of all four rows/events, replay without a provider attempt, and quarantine of an open branch.
14. Successful automatic checkpoint admission now shares one writer transaction with `checkpoint.created`, `context.auto_checkpoint_committed`, `turn.completed`, checkpoint `COMMITTED` state, and turn `COMPLETED` state. Startup validates a prepared checkpoint first, then defers a row tied to a completed task and terminal-adjacent turn so recovery can commit that coupled boundary together. Fresh-migration tests cover rollback and idempotent replay of the checkpoint and terminal publication batch.
15. Restart recovery now enumerates `STARTED`, `UNKNOWN`, and `RECONCILING` side effects before active-turn recovery. For each row it records `tool.settlement_unknown` with `effect-recovery:<side-effect-id>`, updates the linked tool call to `UNKNOWN` and the effect to `MANUAL_REVIEW` in the same writer transaction, and never retries the external operation. A settled effect is skipped without contradictory evidence, and recovery failures make startup fail closed.
16. Provider-attempt identity is now durable beyond attempt number: the control plane derives a fingerprint from the exact request artifact hash, provider/model snapshot hash, admitted endpoint, tool-schema hash, immutable context epoch, and attempt ID. The same identity is written to the provider-running event and `provider_attempts` row with a unique kernel idempotency key; provider-native request IDs and continuation IDs are stored in typed columns when the stream exposes them. A fresh-migration DB test proves atomic publication rollback and duplicate-key rejection. This does not claim provider-level deduplication for endpoints that do not support it.
17. Startup and explicit recovery now enumerate in-flight provider attempts before active-turn recovery. An attempt without a durable response is atomically marked `interrupted`, its active turn is marked `INTERRUPTED`, its active task is `BLOCKED`, and `turn.recovery_interrupted` carries the request identity and reconciliation requirement. A failed transaction leaves all rows and the event unchanged; replay after commit finds no in-flight attempt and emits no second recovery event. No provider request is retried automatically.
18. Task cancellation now reads active and `REPAIR_PENDING` turns under the mutation lock, emits one idempotent `turn.aborted` event per turn plus `task.aborted`, CASes every turn and the task to terminal `ABORTED` state in the same transaction, and only then signals in-process abort controllers. A fresh-migration DB test proves rollback leaves every row and event unchanged, while committed cancellation replays without duplicate abort events.
19. Candidate-branch admission now advances `OPEN` to durable `ADMITTING` before the external merge boundary. Startup and explicit recovery never turn that state back into `OPEN`; without a trusted merge receipt they atomically emit `candidate_branch.recovery_manual_review`, move the branch to `MANUAL_REVIEW`, and block the active task. A fresh-migration DB test proves rollback, one-event replay, stable idempotency, and that an already `ADMITTED` branch is not rescanned. The separate trusted receipt adapter remained open at that point and is now covered by observation 32.
20. Verification recovery now persists the environment binding on the plan and the complete immutable result identity on each result: command/query, exit code, structured observations, artifacts, and verifier version. On restart from `RESPONSE_VALIDATING` or `VERIFYING`, the live loop requires the current source/environment bindings, reconstructs and validates the persisted DAG, reuses only the latest complete result for each node, and executes only missing nodes. It reuses the durable provider response artifact, disables provider-calling scout/compaction auxiliaries, and does not replay provider inference or duplicate proposal/plan-completed events. Fresh migration coverage proves the columns, binding reconstruction, and missing-node-only execution; engine tests reject duplicate, stale, and malformed bindings, while legacy rows are rejected rather than treated as completion evidence.
21. Verification plan derivation now selects typed predicates from the task contract, changed and scoped paths, risk class, repository instruction hashes, current failure/diagnostic signals, generated paths, supplied native test commands, and repository-map/native-recipe provenance. Admission mode makes selected auxiliary checks required; incremental mode keeps them optional and prevents them from blocking required criteria. Each node records the derivation version, signal counts, and selection rationale. The live `agentLoop` passes the current task signals into new plans, while governed UI execution remains explicitly unavailable in this runtime. Focused derivation, runtime, recovery, binding, and exit-gate tests pass; automatic repository-map/native-recipe discovery is now wired, but governed UI proof and full semantic plan coverage remain open.
22. Repair metrics are now derived from durable task, repair-attempt, provider-attempt, and turn records by the provider-neutral `@terminus/verification` reducer and exposed by `GET /v1/tasks/:id`. The reducer preserves exact decimal token and cost values, distinguishes first-proposal success from repair success, records repeated failure and terminal classification, and returns null when trusted usage or cost facts are missing. The repair controller's failure signature now includes normalized evidence references, so a changed evidence artifact counts as progress. `scripts/collect-ops-metrics.ts` now reads a supplied control-plane database and aggregates these records with exact decimal totals; a live stream/export, trusted provider cost source, ground-truth classification labels, and restart/fault proof for the metrics read model remain open.
23. Provider-attempt accounting now separates `provider_reported_cost_micros`, exact `computed_cost_micros`, and a constrained `cost_source`. Runtime settlement uses bigint arithmetic and records admitted economics only as an estimate; an anonymous zero-priced Zen free-model contract is labeled separately, and unavailable/local-command cost remains null. Legacy `cost_micros` is no longer used as measured spend by the task snapshot or ops collector. Provider-reported billing receipts, live export, ground-truth classification labels, and restart/fault proof for the metrics read model remain open.
24. Repository discovery now uses the existing task-scoped kernel READ capability for an allow-list of package, lock, and build metadata files. A pure parser emits at most twelve canonical native test/check invocations from package scripts, Just/Make, Cargo, Python, Go, and Taskfile declarations; it never exposes or executes script bodies, and each emitted recipe retains its source path and source version. Complete reads become observed signals; denied, missing, truncated, malformed, or invalidly versioned files remain explicitly unavailable.
25. `CodeIntelligenceService.Map` now returns a deterministic source-only file-to-symbol map with a canonical index revision, total count, and opaque continuation. The kernel applies workspace path scope before pagination and rejects a stale continuation revision. The control plane follows every continuation within bounded limits, validates paths, symbols, hashes, counts, ordering, revision, and truncation, then projects at most 200 entries into a source-attributed retrieval fragment and passes complete-map provenance into verification-plan derivation. Focused continuation, kernel, typecheck, `just check`, and `just check-all` evidence pass. Retrieval selection metrics and deterministic scoring ablations are now implemented and persisted; one fresh eight-task cache cohort satisfies the local 0.7 average telemetry threshold (`0.7664`) without warnings, while labeled outcome, cache-promotion, monorepo-scale evidence, and the unchanged deterministic lifecycle harness's 1,005/1,006 SSE overlap assertion remain open.
26. The context compiler now records a versioned retrieval-selection contract for every compile: candidate features, method counts, omission reasons, exact token cost, selected use, additive final score, hard-required status, and deterministic selection reasons. A pure reducer computes oracle file/symbol recall, irrelevant-fragment rate, context tokens per verified success, first-attempt localization/edit correctness, repeated reads/searches, realized cache-prefix reuse, and unseen-monorepo quality when those labels are supplied; absent labels remain null. `ablateScoringWeights` and `standardScoringAblations` provide deterministic offline one-at-a-time comparisons, and the scorer no longer lets one zero feature erase independent evidence. No learned ranker or advanced default was promoted, and no empirical holdout result is claimed.
27. Provider settlement now records predicted cached tokens, realized cached tokens, and the observed ratio inside the durable context observation. The Prisma context-store projection reads a valid decimal observation back as `observedCachedTokens` and preserves `null` for absent or malformed values. Focused cache/provider/context tests and current-HEAD full validation pass; observation 30 proves the first fresh live probe and observation 31 records the eight-task cohort, while 20-run release promotion, labeled retrieval outcomes, and monorepo-scale evidence remain open.
28. UI-looking verification criteria now derive the provider-neutral `ui_e2e` predicate, and UI paths create that predicate even when governed computer use is unavailable. The standard predicate executor emits a blocked result with explicit capability evidence and does not invoke the generic command runner when the capability is absent; the kernel-backed production command normalizer also rejects `ui_e2e` unless a configured governed computer-use verifier exists. Focused package tests, `just check`, `just codegen-check`, and current-HEAD `just check-all` pass. This proves typed planning and fail-closed unavailable behavior, not an actual browser/desktop execution loop or live UI evidence.
29. Migration `0018_provider_datetime_bigint.sql` was applied to a fresh isolated control database after the live `PUT /v1/gateway-provider-config` exposed the `INTEGER` overflow. `tests/persistence/migration_integrity.test.ts` now applies all 19 migrations and uses the generated Prisma client to create and read both provider rows with millisecond timestamps beyond the 32-bit range. The focused suite passed 5/5 tests; `just codegen-check` includes migrations `0018` and `0019` in generated inventory/SQLx documentation.
30. A fresh isolated kernel/control stack recorded the first live cache observation through the anonymous OpenCode Zen path. The configured gateway was `deployment=zen`, `model=hy3-free`, `free_model=true`, `workspace_access=true`, `credential_configured=false`; `GET /v1/provider-models` returned `provider=open_code_zen`, `free=true`, `context_tokens=190000`, and `output_tokens=64000`. The successful task was `f855f39d-22a9-4d17-838e-65bf275068e2`, turn `693e4cb1-f2eb-4c87-8547-5fd5e2fae603`, provider attempt `d8b9cf1d-8b28-4b6c-8eb7-28399f83dd7b`, and context manifest `01a0448d-43de-724b-92e0-fdb5ad3e88b4`; the task and turn reached `COMPLETED`, the response artifact was `artifact://sha256/4fa00185e125e075b288f5b1bda2eb012acb9b9948000cc3e8598bf2964cb284`, and verification/branch admission completed. Persisted usage was `inputTokens=1299`, `cachedInputTokens=896`, `outputTokens=48`; the manifest predicted `1025` cached tokens and emitted `context.cache_ratio_observed` with ratio `0.8741` and `consecutive_low_misses=0`. The preceding fresh task `53639c1c-9b95-43d2-948a-e2a3db714243` had a successful provider settlement with predicted `1025` and actual `0` before failing only at Git-based verification because its temporary workspace had no commit. Kernel logs for the successful task recorded connector `opencode-gateway-anonymous` to `https://opencode.ai:443`, HTTP `200`, outcome `Accepted`, request bytes `6251`, response bytes `4539`, and no credential header. This is one fresh operational probe, not a sufficient cache cohort, threshold certification, promotion evidence, or provider billing receipt.
31. A second fresh isolated kernel/control stack ran eight sequential tasks in one trusted local workspace/session against anonymous OpenCode Zen `hy3-free`. The workspace was `01a0449f-5fc8-7b43-9a76-e63edb12fb64` and the session was `11d202bb-0ef2-454c-a22a-7d9ba67e6641`; tasks were `364ec989-74b5-41b6-aaf5-9dbce7840619`, `9bd35a2b-9923-4c0d-97a9-a9560c046c6b`, `17b73554-43f3-4232-90bd-51dfcb7c74e0`, `653b79d7-e8c6-4e71-b70d-b2f1a81a1602`, `62edff2f-cd5c-4d0f-a876-f7272924254e`, `a72f4ea8-46ba-41cb-ab38-05834f5ef233`, `640d675e-ed64-4995-a3bc-d4b2ca52bd64`, and `dd5a7f4e-50f7-4a99-8300-9b1cd300f1dc`. Every task and turn reached `COMPLETED` through normal verification. All eight manifests used `predictedCachedTokens=1023` and stable-prefix hash `sha256:d584dd0af931513543be262320fbaeb189a0a1c45f03cc2b10287b8e8b48eb90`; the first attempt realized `0` cached tokens (`ratio=0`), and the next seven each realized `896` (`ratio=0.8759`). `collect-cache-telemetry.ts` produced `status=measured`, `attemptsObserved=8`, `averageRatio=0.7664`, `minimumRatio=0`, `threshold=0.7`, and `warningsEmitted=0`. All eight attempts were labeled `costSource=free_model_contract` with `computedCostMicros=0`. This satisfies the local average cache-telemetry threshold for this fresh cohort, not the separate 20-run release-promotion, labeled retrieval-outcome, endpoint-deduplication, or monorepo-scale requirements.
32. Candidate branch recovery now has a provider-neutral trusted receipt contract. `CandidateBranchMergeReceipt` binds the deterministic operation ID, branch/task/attempt/actor identity, base and candidate revisions, scope digest, completion-record digest, merge ID, authoritative revision, and an immutable artifact hash/URI. `AdmissionService.reconcileAdmittingBranch` validates every binding and never invokes the merger: an `EXECUTED` receipt commits validated branch effects and moves `ADMITTING` to `ADMITTED`, while a trusted `NOT_EXECUTED` or `AMBIGUOUS` receipt is retained and fences the branch in `MANUAL_REVIEW`; absent or mismatched receipt queries fail closed. Migration `0019_candidate_branch_merge_receipts.sql` and the Prisma adapter persist the receipt. The task-runtime suite passed 27/27 tests, and the fresh Prisma recovery test passed 1/1 with one-query-only replay. This proves the contract and durable local transition, not a configured real remote Git/merge adapter or startup promotion of such an adapter; the live control path remains conservative until that adapter is supplied.

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

## Verification recovery evidence

Migration `0016_verification_recovery_identity.sql` adds the environment digest
to verification plans and preserves the full result identity required to
resume a verifier after a control-plane restart. Legacy rows with missing
identity fields remain non-resumable and therefore cannot silently satisfy a
completion gate.

`tests/recovery/verification_recovery.test.ts` applies a fresh migration set,
reads a persisted two-node plan and one complete result through the same
Prisma-row adapters used by the control plane, validates the verifier binding,
and runs the engine with `resumeResults`. The executor is called only for the
missing node; the settled node is not re-executed and both nodes satisfy the
completion expression. The package tests also cover duplicate, stale, and
malformed resume inputs.

Plan derivation coverage is in
`packages/verification/src/plan-derivation.test.ts`. It proves that the
deriver selects parse, formatting, diagnostics, native tests, migration,
schema, security, UI, and criterion-specific predicates from representative
signals. It also proves that incremental auxiliary nodes are optional and do
not become dependencies of the required criterion. The control-plane adapter
uses the same deriver for newly created admission plans.

## Durable repair metrics evidence

`packages/verification/src/repair-metrics.ts` contains a pure reducer over
durable repair facts. It has no provider, filesystem, database, or clock
dependency. `mini-services/terminus-control/src/index.ts` reads the task's
repair attempts, repair-turn provider attempts, verification result state, and
whole-turn timestamps, then exposes the reducer's snake-case record from
`GET /v1/tasks/:id`. Cost is included only when its durable source is trusted:
provider-reported billing or an explicit free-model contract. Admitted
economics is retained as an estimate for operational accounting, but is not
presented as provider spend. The reducer tests cover first-proposal success,
repair success, repeated signatures, blocked/budget outcomes, exact decimal
aggregation, missing usage, invalid values, and duration failures.

The metrics are local implementation evidence, not release telemetry. The
collector reads the control-plane database only when
`TERMINUS_OPS_METRICS_DB` or `DATABASE_URL` is supplied. New provider attempts
persist exact computed cost plus its source in the split accounting columns;
provider-reported cost is still unavailable in the exercised provider
responses, so aggregate provider spend remains null unless the source is
`provider_reported` or `free_model_contract`. The legacy c94 live row below
predates this split and retains its observed zero sentinel.

## Live OpenCode free-model evidence

This closes the live-provider proof for one supported anonymous public Zen path and records a fresh eight-task cache cohort whose local average telemetry threshold is satisfied. It does not close paid-account, alternate-protocol, 20-run release-promotion, retrieval-outcome, cross-platform, hosted-CI, or release gates.

| Surface | Observed evidence |
| --- | --- |
| Configuration | `PUT /v1/gateway-provider-config` admitted `deployment=zen`, `model=hy3-free`, `free_model=true`, `workspace_access=true`, and `credential_configured=false` at revision `1`, with the current Zen privacy-term identity. |
| Discovery | `GET /v1/provider-models` returned `hy3-free` as `provider=open_code_zen`, `free=true`, with `context_tokens=190000` and `output_tokens=64000`. The request used the explicit anonymous kernel connector. |
| Historical provider attempt | Task `74e8a44f-6333-4def-98da-2a10a843bfb3`, turn `4dc54750-1730-4236-931f-cd7c32a0e435`, and provider attempt `7a59c234-639f-49f5-805e-c98916b124a5` persisted `provider=open_code_zen`, `model=hy3-free`, `status=completed`, `cost_micros=0`, `inputTokens=1177`, and `outputTokens=893`. This c94 observation predates the split cost columns and is retained as a historical legacy sentinel, not current spend evidence. |
| Historical kernel receipt | The kernel recorded connector `opencode-gateway-anonymous` to `https://opencode.ai:443` with `status=200`, `outcome=Accepted`, `request_bytes=5863`, and `response_bytes=66967`. No credential header was injected. |
| Historical lifecycle | The same turn persisted `turn.response_validating`, `completion.proposed`, `turn.verifying`, `verification.admitted`, `turn.finalizing`, `context.auto_checkpoint_committed`, and `turn.completed`; the turn and task both ended `COMPLETED`. |
| Historical immutable response | The provider response was retained as `artifact://sha256/45cb876fa025ad457532eb2da20954deb6f4bf2f7ad8270369a1632d825a65a8`. The verification result was `pass` with its own immutable evidence artifact. |
| Fresh provider/cache probe | Task `f855f39d-22a9-4d17-838e-65bf275068e2`, turn `693e4cb1-f2eb-4c87-8547-5fd5e2fae603`, provider attempt `d8b9cf1d-8b28-4b6c-8eb7-28399f83dd7b`, and context manifest `01a0448d-43de-724b-92e0-fdb5ad3e88b4` persisted `provider=open_code_zen`, `model=hy3-free`, `status=completed`, `computed_cost_micros=0`, `cost_source=free_model_contract`, `inputTokens=1299`, `cachedInputTokens=896`, and `outputTokens=48`. The manifest predicted `1025` cached tokens and the durable observation recorded ratio `0.8741`. |
| Fresh kernel receipt | The successful task's kernel log recorded connector `opencode-gateway-anonymous` to `https://opencode.ai:443` with `status=200`, `outcome=Accepted`, `request_bytes=6251`, and `response_bytes=4539`. No credential header was injected. |
| Fresh lifecycle | The task and turn reached `COMPLETED` after provider settlement, proposal, verification, branch admission, and checkpoint publication. The immutable response artifact was `artifact://sha256/4fa00185e125e075b288f5b1bda2eb012acb9b9948000cc3e8598bf2964cb284`. |
| Fresh cache cohort | Eight sequential tasks in workspace `01a0449f-5fc8-7b43-9a76-e63edb12fb64` and session `11d202bb-0ef2-454c-a22a-7d9ba67e6641` all completed. One cold observation was `0/1023`; seven warm observations were `896/1023` with the same stable-prefix hash, yielding collector status `measured`, average `0.7664`, minimum `0`, threshold `0.7`, and zero warnings. |

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
| 2026-08-26 | `bun test tests/recovery/verification_recovery.test.ts` | PASSED — 1 fresh-migration DB-backed test, 0 failures, 7 expect calls; persisted verification identity was reconstructed and only the missing node executed. |
| 2026-08-26 | `bun test tests/recovery/verification_recovery.test.ts packages/verification/src/verification.test.ts packages/verification/src/exit-gate.test.ts` | PASSED — 36 tests, 0 failures, 95 expect calls; resume validation, lifecycle binding restoration, completion gating, and DB-backed recovery all passed. |
| 2026-08-26 | `bun run typecheck --pretty false` | PASSED — root TypeScript typecheck completed with no diagnostics after the verification recovery implementation. |
| 2026-08-26 | `just fault-injection` from committed `d3760b1` | PASSED — the artifact records 13 `fixture_only` boundaries, 13 DB-backed scenarios, 38 passing recovery tests, and `completeForRelease: false`; `verification_recovery_replay` covers the post-verification-start boundary. |
| 2026-08-26 | `just codegen-check` after committing `d3760b1` | PASSED — generated protobuf, API, event, tool, config, schema, SQLx, and documentation outputs are stable with migration `0016_verification_recovery_identity`. |
| 2026-08-26 | `bun test packages/verification/src/plan-derivation.test.ts packages/verification/src/verification.test.ts packages/verification/src/exit-gate.test.ts tests/recovery/verification_recovery.test.ts mini-services/terminus-control/src/verification-runtime.test.ts` | PASSED — 41 tests, 0 failures, 120 expect calls; signal-derived plan selection, incremental/admission dependency rules, verification resume, binding rejection, exit-gate, and control-plane node namespace coverage pass. |
| 2026-08-26 | `bun run typecheck --pretty false` after `a42acc5` | PASSED — root TypeScript typecheck completed with no diagnostics after wiring structured diagnostics into plan derivation signals. |
| 2026-08-26 | `just codegen` after `a42acc5` | PASSED — generated outputs completed; inventory now records 120 TypeScript test files and 945 declared TypeScript test blocks. |
| 2026-08-26 | `just check` after `a42acc5` | PASSED — boundary checks, Rust fmt/clippy, ESLint (0 errors; 2 existing generated-file warnings), package/scripts/root TypeScript, and Python ruff/mypy. |
| 2026-08-26 | `just codegen-check` after `ada2dec` | PASSED — generated paths are stable against the committed signal-derived plan and evidence ledger. |
| 2026-08-26 | `just fault-injection` after `ada2dec` | PASSED — the artifact records 13 `fixture_only` boundaries, 13 DB-backed scenarios, and `completeForRelease: false`; verification recovery remains in the DB-backed replay set. |
| 2026-08-26 | `just check-all` after `ada2dec` | PASSED — the full local check-all command exited 0; the final cargo-deny result reported `advisories ok, bans ok, licenses ok, sources ok`. |
| 2026-08-26 | `bun test packages/verification/src/repair-metrics.test.ts mini-services/terminus-control/src/agent/verification-repair-controller.test.ts` | PASSED — 17 tests, 0 failures, 50 expect calls; repair metrics reduction and evidence-aware repeated-failure detection pass. |
| 2026-08-26 | `bun test packages/verification/src/repair-metrics.test.ts packages/verification/src/plan-derivation.test.ts packages/verification/src/verification.test.ts packages/verification/src/exit-gate.test.ts mini-services/terminus-control/src/agent/verification-repair-controller.test.ts mini-services/terminus-control/src/verification-runtime.test.ts tests/recovery/verification_recovery.test.ts tests/recovery/repair_attempt_recovery.test.ts` | PASSED — 61 tests, 0 failures, 187 expect calls. |
| 2026-08-26 | `bun run typecheck --pretty false` after `c94f7fd` | PASSED — root TypeScript typecheck completed with no diagnostics. |
| 2026-08-26 | `just check` after `c94f7fd` | PASSED — boundary checks, Rust fmt/clippy, ESLint (0 errors; 2 existing generated-file warnings), package/scripts/root TypeScript, and Python ruff/mypy. |
| 2026-08-26 | `just codegen` after `c94f7fd` | PASSED — generated outputs completed and the inventory records 121 TypeScript test files and 949 declared TypeScript test blocks. |
| 2026-08-26 | `just codegen-check` after committing `c94f7fd` | PASSED — generated protobuf, API, event, tool, config, schema, SQLx, and documentation outputs are stable. |
| 2026-08-26 | `just fault-injection` after `c94f7fd` | PASSED — 13 DB-backed recovery scenarios ran and the artifact reports `status: passed` with `completeForRelease: false`. |
| 2026-08-27 | `just check-all` after `c94f7fd` | PASSED — the full local command exited 0; the inspected tail reported `advisories ok, bans ok, licenses ok, sources ok`. |
| 2026-08-27 | `bun run scripts/collect-ops-metrics.ts` with no database URL | PASSED — the artifact remained `status: placeholder` with an explicit empty repair aggregate. |
| 2026-08-27 | Fresh migrated SQLite database plus `TERMINUS_OPS_METRICS_DB=... bun run scripts/collect-ops-metrics.ts` | PASSED — Prisma read the current schema and produced the explicit empty repair aggregate; no repository database was modified. |
| 2026-08-27 | `bun test packages/provider-core/src/cost.test.ts packages/provider-economics/src/economics.test.ts mini-services/terminus-control/src/services/services.test.ts` | PASSED — 15 tests, 0 failures, 54 expect calls; exact bigint cost computation, cached-input accounting, anomaly detection, economics estimates, and cost-source propagation pass. |
| 2026-08-27 | `bun test tests/persistence/migration_integrity.test.ts` | PASSED — 5 tests, 0 failures, 34 expect calls; migration `0017_provider_attempt_cost_accounting.sql` applies and its three provider-attempt columns are present. |
| 2026-08-27 | `bun run typecheck --pretty false` | PASSED — root TypeScript typecheck completed with no diagnostics after exact cost settlement wiring. |
| 2026-08-27 | `just codegen` | PASSED — generated outputs completed; inventory records 122 TypeScript test files, 952 declared TypeScript test blocks, and 17 SQLite migrations. |
| 2026-08-27 | `just check-all` after `09b9d38` | PASSED — the full local command exited 0; boundary, Rust, TypeScript, Python, integration, security, standalone/truth, generated-contract, and `cargo deny` checks passed. One explicitly ignored live conformance canary remains. |
| 2026-08-27 | Fresh database migrated through `0017_provider_attempt_cost_accounting.sql` plus `TERMINUS_OPS_METRICS_DB=... bun run scripts/collect-ops-metrics.ts` | PASSED — Prisma read the new cost columns and the collector emitted the explicit empty repair aggregate; no repository database was modified. |
| 2026-08-27 | `bun test mini-services/terminus-control/src/agent/repository-signals.test.ts mini-services/terminus-control/src/agent/retrieval-hydrator.test.ts packages/verification/src/plan-derivation.test.ts` | PASSED — 13 tests, 0 failures, 44 expect calls; native recipe parsing, continuation-aware map-fragment rendering, and signal-derived verification plans pass. |
| 2026-08-27 | `cargo test -p terminus-code-intel && cargo test -p terminus-authz` | PASSED — 13 code-intelligence tests and 17 authorization tests, 0 failures. |
| 2026-08-27 | `cargo test --manifest-path mini-services/terminus-kernel/Cargo.toml` | PASSED — 12 tests, 0 failures; scoped map paging and stale-continuation rejection pass. |
| 2026-08-27 | `bun run typecheck --pretty false` | PASSED — root TypeScript typecheck completed with no diagnostics after repository discovery wiring. |
| 2026-08-27 | `just check` | PASSED — boundary checks, Rust fmt/clippy, ESLint with 0 errors and 2 existing generated-file warnings, package/scripts/root TypeScript, and Python ruff/mypy. |
| 2026-08-27 | `just codegen-check` from committed `6850036` | PASSED — generated protobuf, API, schema, and documentation outputs are stable. |
| 2026-08-27 | `just check-all` from committed `6850036` | PASSED — full local boundary, Rust, TypeScript, Python, integration, security, standalone/truth, generated-contract, and dependency checks; one explicitly ignored live conformance canary remains. |
| 2026-08-27 | `bun test mini-services/terminus-control/src/agent/repository-map.test.ts mini-services/terminus-control/src/agent/retrieval-hydrator.test.ts mini-services/terminus-control/src/agent/repository-signals.test.ts packages/verification/src/plan-derivation.test.ts` | PASSED — 19 tests, 0 failures, 59 expect calls; complete continuation reads, revision/count/ordering/bounds rejection, complete-read prompt omission behavior, native recipes, and signal-derived plans pass. |
| 2026-08-27 | `just check-all` after `8a2923d` | PASSED — the full local command exited 0; boundary, Rust, TypeScript, Python, integration, security, standalone/truth, generated-contract, and dependency checks passed. One explicitly ignored live conformance canary remains. |
| 2026-08-27 | `bash scripts/e2e/deterministic.sh` after `8a2923d` | FAILED — the unchanged restart harness received 1,005 of 1,006 expected SSE events and timed out after 10 seconds waiting for the live `task.aborted` overlap event. The isolated kernel/control stack started and earlier lifecycle/recovery assertions passed; this run is not full lifecycle proof. |
| 2026-08-27 | `bun test packages/context-compiler/src` | PASSED — 46 tests, 0 failures, 163 expect calls; retrieval selection/outcome aggregation, scoring ablation, manifest persistence, cache diagnostics, compaction, replay, and existing context invariants pass. |
| 2026-08-27 | `bun run typecheck --pretty false` | PASSED — root TypeScript typecheck completed with no diagnostics after retrieval metric integration. |
| 2026-08-27 | `just check` | PASSED — boundary checks, Rust fmt/clippy, ESLint with 0 errors and 2 existing generated-file warnings, package/scripts/root TypeScript, and Python ruff/mypy. |
| 2026-08-27 | `just codegen-check` from committed `410685f` | PASSED — generated protobuf, API, event, tool, config, schema, SQLx, and documentation outputs are stable. |
| 2026-08-27 | `just check-all` after `410685f` | PASSED — the full local command exited 0; boundary, Rust, TypeScript, Python, integration, security, standalone/truth, generated-contract, and dependency checks passed. One explicitly ignored live conformance canary remains. |
| 2026-08-27 | `bun test mini-services/terminus-control/src/context-store.test.ts mini-services/terminus-control/src/agent/cache-telemetry.test.ts mini-services/terminus-control/src/direct-provider-transport.test.ts packages/context-compiler/src` | PASSED — 62 tests, 0 failures, 208 expect calls; valid provider cache observations read back as exact counts and malformed or absent observations remain null. |
| 2026-08-27 | `bun run typecheck --pretty false` after `050115f` | PASSED — root TypeScript typecheck completed with no diagnostics after durable cache observation read-back wiring. |
| 2026-08-27 | `just check` after `050115f` | PASSED — boundary checks, Rust fmt/clippy, ESLint with 0 errors and 2 existing generated-file warnings, package/scripts/root TypeScript, and Python ruff/mypy. |
| 2026-08-27 | `just codegen-check` from committed `050115f` | PASSED — generated protobuf, API, event, tool, config, schema, SQLx, and documentation outputs are stable after cache read-back wiring. |
| 2026-08-27 | `just check-all` after `050115f` | PASSED — 599 Bun unit tests, 257 Python tests, 294 integration tests, Rust workspace tests, security suites, platform probes, standalone/truth, generated-contract, and dependency checks passed. One explicitly ignored live conformance canary remains. |
| 2026-08-27 | `bun test packages/verification/src` | PASSED — 55 tests, 0 failures, 169 expect calls; typed UI derivation, unavailable-capability blocking, and existing verification behavior pass. |
| 2026-08-27 | `just check` after the UI slice committed as `b693ddb` | PASSED — boundary checks, Rust fmt/clippy, ESLint with 0 errors and 2 existing generated-file warnings, package/scripts/root TypeScript, and Python ruff/mypy. |
| 2026-08-27 | `just codegen-check` from committed `b693ddb` | PASSED — generated protobuf, API, event, tool, config, schema, SQLx, and documentation outputs are stable. |
| 2026-08-27 | `just check-all` after `b693ddb` | PASSED — 601 Bun unit tests, 257 Python tests, Rust workspace and integration/security tests, platform probes, standalone/truth, generated-contract, and dependency checks passed. One explicitly ignored live conformance canary remains. |
| 2026-08-27 | `DATABASE_URL=file:/private/tmp/terminus-live.OGVX5A/control.db bun run scripts/migrate.ts` | PASSED — fresh control database applied migration `0018_provider_datetime_bigint.sql`; the migration ledger reported 18 total migrations and integrity passed. |
| 2026-08-27 | `bun test tests/persistence/migration_integrity.test.ts` | PASSED — 5 tests, 0 failures, 38 expect calls; legacy provider timestamps retain millisecond precision and generated Prisma clients can create/read both provider configuration rows after migration `0018`. |
| 2026-08-27 | `just codegen` and `just codegen-check` from committed `69ffb70` | PASSED — generated inventory and SQLx documentation record 18 SQLite migrations; all generated outputs are stable. |
| 2026-08-27 | Isolated fresh kernel/control stack: configure anonymous `hy3-free`, discover models, submit a task through `/v1/workspaces/open`, `/v1/sessions`, `/v1/tasks`, `/v1/tasks/:id/start`, and `/v1/turns`, then read back public projections, rollout, SQLite, and kernel logs | PASSED — task `f855f39d-22a9-4d17-838e-65bf275068e2` and turn `693e4cb1-f2eb-4c87-8547-5fd5e2fae603` completed; provider attempt `d8b9cf1d-8b28-4b6c-8eb7-28399f83dd7b` used `open_code_zen/hy3-free`, kernel connector status was 200/Accepted, and persisted cache usage was 896 realized versus 1025 predicted (`0.8741`). The preceding provider-success task failed only at Git-based verification because its temporary workspace lacked a commit; it was not counted as successful lifecycle evidence. |
| 2026-08-27 | `just check` at implementation head `69ffb70` | PASSED — boundary checks, Rust formatting/clippy, ESLint, package/scripts/root TypeScript, and Python ruff/mypy completed successfully; existing non-fatal Rust and generated-file ESLint warnings remain. |
| 2026-08-27 | `just check-all` at implementation head `69ffb70` | PASSED — the full local boundary, Rust, TypeScript, Python, integration, security, standalone/truth, generated-contract, platform, and dependency checks exited 0. One explicitly ignored live conformance canary remains. |
| 2026-08-27 | Isolated fresh eight-task anonymous Zen cache cohort through the kernel and control plane | PASSED — all eight tasks and turns reached `COMPLETED`; the manifests shared stable-prefix hash `sha256:d584dd0af931513543be262320fbaeb189a0a1c45f03cc2b10287b8e8b48eb90`, with one `0/1023` cold observation and seven `896/1023` warm observations (`0.8759` each). |
| 2026-08-27 | `TERMINUS_CACHE_TELEMETRY_DB=file:/var/folders/dh/_042nc7d1pq3d0g03jlldh3h0000gn/T/terminus-cache-cohort.XXXXXX.XXZovnk1Jc/control.db TERMINUS_CACHE_RATIO_THRESHOLD=0.7 bun run scripts/collect-cache-telemetry.ts` | PASSED — wrote `artifacts/release-gate/cache-telemetry.json` with `status=measured`, 8 observations, average ratio `0.7664`, minimum `0`, threshold `0.7`, and zero warnings. |
| 2026-08-27 | `just m12-exit-gate` | BLOCKED — `release-source-check` refused to produce commit-bound release evidence because the preserved user-owned `SPEC.md` edit leaves the checkout dirty; the cache artifact was collected separately and no release decision was made. |

## Evidence policy

- `PASSED` means the command exited successfully in this checkout and its relevant output was inspected.
- `FAILED` includes the exact failure class and useful tail.
- `BLOCKED` means an external credential, host, platform, or remote permission is required.
- `UNVERIFIED` means source or a partial local test suggests behavior but does not prove the acceptance condition.

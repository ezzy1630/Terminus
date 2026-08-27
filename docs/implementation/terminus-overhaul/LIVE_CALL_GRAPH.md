# Terminus live call graph

Revision: complete bounded repository-map continuation commit `8a2923d`; ledger state is recorded in `HANDOFF.md`.

## Verified primary path

```text
HTTP/RPC route in mini-services/terminus-control/src/index.ts
  -> durable turn admission / task contract load
  -> agentLoop(turnId)
  -> turn state PENDING -> CONTEXT_COMPILING
  -> context artifact load + provider selection
  -> ContextStateBuilder + Context Compiler
  -> task-scoped kernel FileService.Read for allow-listed repository metadata
  -> task-scoped kernel CodeIntelligenceService.Map for a revisioned, path-scoped repository map
  -> complete bounded continuation read with revision/count/order/hash validation or explicit unavailable signal
  -> at most 200 complete map entries projected into the model fragment with explicit omission/search guidance
  -> ContextStore persists manifest and rendered request
  -> canonical provider-attempt fingerprint + kernel idempotency key
  -> ProviderSessionService.beginAttempt / execute / settleResponse
  -> CodingTurnEngine
  -> ToolEpisodeService -> policy/effect settlement -> kernel RPC
  -> provider continuation
  -> final provider projection
  -> `completion.proposed` artifact/event
  -> turn RESPONSE_VALIDATING -> VERIFYING
  -> VerificationCoordinator -> VerificationRuntime -> signal-derived VerificationPlan -> kernel predicates
  -> verification plan/results/evidence persisted
  -> completion record persisted as `PREPARED`
  -> candidate branch registered
  -> `OPEN` -> `ADMITTING` epoch fence before external merge
  -> `ADMITTED` on durable admission, or `MANUAL_REVIEW` plus task `BLOCKED` after restart without a trusted receipt
  -> atomic task COMPLETED + turn VERIFIED + completion record `COMMITTED` admission
  -> turn FINALIZING
  -> prepare automatic checkpoint
  -> atomic checkpoint admission + `checkpoint.created` + `context.auto_checkpoint_committed` + turn COMPLETED + `turn.completed`
  -> explicit `context.auto_checkpoint_failed` fallback when preparation cannot complete
```

Repair path:

```text
VERIFYING failure
  -> `turn.repair_pending` + `task.repair_scheduled` + cited directive
  -> cumulative budget/signatures/source revision restored
  -> repair-controller child turn admitted
  -> parent REPAIR_PENDING superseded as ABORTED
  -> child enters the same `agentLoop` at REPAIRING
  -> context/provider/tools -> VERIFYING -> admit or another bounded repair
```

Repository discovery path:

```text
compileProviderContext
  -> `FileService.Read` for package/lock/build metadata under the existing READ capability
  -> native recipe parser emits bounded canonical commands plus source paths and source versions
  -> `CodeIntelligenceService.Map` refreshes the source-only index and returns sorted paths, symbols, revision, total, and opaque continuation
  -> kernel applies workspace path scope before pagination and rejects stale continuations
  -> control follows every bounded continuation and validates paths, hashes, symbols, counts, ordering, revision, and truncation; malformed or partial responses become unavailable
  -> complete map observation is projected to a bounded source-attributed repository-map `ContextFragment`
  -> verification-plan derivation receives native commands, recipe provenance, and map provenance
```

Cancellation path:

```text
task/turn cancel request
  -> mutation-lock transaction emits one `turn.aborted` per active turn plus `task.aborted`
  -> the same transaction CASes every active or REPAIR_PENDING turn and the task to durably ABORTED
  -> after commit, turn AbortControllers reach compaction/provider/tools/process/verification
  -> dispatched ambiguous effects are atomically recorded as tool UNKNOWN + effect MANUAL_REVIEW with `tool.settlement_unknown`
```

## Supporting paths observed in source

| Component | Entry or construction | Current classification | Required action |
| --- | --- | --- | --- |
| `CodingTurnEngine` | `agentLoop` | live, provider-neutral loop | Durable callbacks, cancellation checks, batched settlement, and first-class doom-loop outcome are wired; full restart proof remains. |
| `TurnBudget` | `CodingTurnEngine` | live, process-local policy | Semantic operation accounting and stagnation stops are wired; durable restart accounting remains. |
| `ContextStateBuilder` | `compileProviderContext` | live overlay | Full-window episode state plus world-state overlays are supplied; authoritative durable working-set ledger remains. |
| `runCompaction` | `compileProviderContext` | live, fail-closed | Source text/provenance, cited summary, signal, and atomic production commit path are required before hiding. |
| Repository instructions | `loadRepositoryInstructionFragments` | live, kernel-read | Relevant scopes are read through the kernel and injected as hashed required fragments; full invalidation coverage remains. |
| `Context Compiler` | `compileContext` in `packages/context-compiler` | live | Manifests, exact prefixes, project rules, source hashes, candidate selection features, exact token costs, versioned retrieval metrics, additive scores, deterministic offline scoring ablations, and provider predicted/realized cache observations are retained; labeled outcome and fresh live cache evidence remain. |
| Repository map/native recipes | `discoverRepositorySignals` in `mini-services/terminus-control/src/index.ts` | live, kernel-backed, bounded | Allow-listed metadata reads, scoped revisioned map paging, complete continuation aggregation, source hashes, native recipe provenance, explicit unavailable paths, and a 200-entry model projection are wired; the compiler records selection metrics/ablation inputs and provider cache observations read back through the context store, while labeled retrieval outcomes, fresh cache behavior, and monorepo-scale evidence remain. |
| Provider retry/runtime | `agentLoop` and `providers/*` | live, partial | Attempt stages, canonical request fingerprint/idempotency key, native response metadata, no-duplicate in-flight recovery, direct-stream fallback guards, abort propagation, one anonymous OpenCode Zen free-model completion through the kernel, and durable predicted/realized cache observation persistence are proven; endpoint-level deduplication, trusted receipt reconciliation, paid-account, alternate-protocol, fresh live cache telemetry, and broader live conformance remain. |
| Verification runtime | `agentLoop` | live, post-proposal | Owns completion admission; new plans derive typed predicates from contract and current task signals including repository-map/native-recipe provenance, UI criteria select `ui_e2e`, and unavailable governed computer use produces an explicit blocked result without generic command dispatch. Exact `RESPONSE_VALIDATING`/`VERIFYING` resume uses persisted response/plan/result identity, durable `ADMITTING` fencing and conservative `MANUAL_REVIEW` recovery remain, and DB-backed proposal/cancellation/completion/branch/verification replay are proven. Trusted external merge receipt, configured governed UI execution, full semantic plan coverage, and runtime proof of discovered recipe execution remain. |
| `VerificationRepairController` | `agentLoop` | live, partial | Cumulative budget, signatures including normalized evidence references, directive, child re-entry, parent supersession, durable lease, DB-backed repair replay, task-level repair metrics, and exact provider-attempt cost-source separation are wired; trusted provider billing, aggregate export, and the remaining fault boundaries are open. |
| Repair metrics projection | `GET /v1/tasks/:id`, `scripts/collect-ops-metrics.ts` | live, provider-neutral read model | `deriveRepairMetrics` reduces durable repair attempts, repair-turn provider usage, verification admission, terminal state, and whole-turn duration; the collector aggregates supplied durable database records with exact decimal totals. Provider-reported cost and explicit free-model contracts can be trusted; admitted economics remains labeled as computed rather than provider spend. Live export and restart/read-model proof remain open. |
| Stagnation supervisor | `/v2/orchestration/stagnation/check` | endpoint/live helper | Reconcile with engine/catalog and structured stop state. |
| Scout runner | `agentLoop` before main context | live only with explicit opt-in | `TERMINUS_ENABLE_SCOUT=1` is required; utility ledger and promotion evidence remain. |
| Model router | package/control imports | experimental unless proven | Shadow only, fixed fallback. |
| Subagents | control feature modules | experimental/default-off tests | Isolated worktrees and parent-consumption evidence. |
| Browser/desktop | endpoints or packages if present | unsupported/experimental | The verification plan can require `ui_e2e` and fail closed when capability is unavailable; do not claim governed computer use without a real browser/desktop loop. |
| Cron/automation | package and route inventory | unverified | Enqueue through canonical executor only. |

## Recovery boundary

Startup recovery first enumerates `STARTED`/`UNKNOWN`/`RECONCILING` effects. Each ambiguous v1 effect is atomically recorded as tool `UNKNOWN`, effect `MANUAL_REVIEW`, and `tool.settlement_unknown` with a deterministic `effect-recovery:<id>` key; no effect is retried without a trusted receipt query. Provider attempts publish a canonical fingerprint and unique kernel idempotency key before dispatch, with native request and continuation IDs retained when returned. An in-flight provider attempt without a durable response is atomically marked `interrupted`, its turn is marked `INTERRUPTED`, its active task is blocked, and `turn.recovery_interrupted` records the reconciliation requirement; no provider request is replayed automatically. Candidate branches in `ADMITTING` are then fenced by epoch and moved atomically to `MANUAL_REVIEW` with `candidate_branch.recovery_manual_review`; an active or verifying task is blocked, and no merge is retried without a trusted external receipt query. It then resumes PENDING/CONTEXT_COMPILING/REPAIRING and settled TOOL_SETTLEMENT work when provider/effect state is unambiguous. Prepared completion records are reconciled only when their candidate branch is `ADMITTED`; a matching VERIFYING task/turn is completed through the coordinator without provider replay, and unsafe intents are quarantined. A completion proposal by itself remains non-terminal. RESPONSE_VALIDATING and VERIFYING now require a durable provider response artifact, exact current source/environment bindings, a valid persisted plan DAG, and complete verifier-bound results; settled nodes are reused and only missing nodes execute. Legacy, malformed, or stale state fails closed, and the provider is never called during this recovery path. Task cancellation is one atomic task/turn/event batch before in-process abort signaling. A valid PREPARED checkpoint tied to a completed task and FINALIZING/VERIFIED source turn is deferred until terminal recovery can commit checkpoint and terminal rows/events together. Verified/finalizing turns require a completed task, a `COMMITTED` completion record, and proposal response artifact; otherwise recovery emits `turn.recovery_failed` and blocks the task.

The graph is a source-level map, not proof of runtime completion. Proof is in `EVIDENCE.md` and must be extended with live provider, crash/replay, cross-platform, client, and release observations.

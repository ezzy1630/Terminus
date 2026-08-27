# Terminus live call graph

Revision: functional provider-attempt identity commit `8983439`; ledger state is recorded in `HANDOFF.md`.

## Verified primary path

```text
HTTP/RPC route in mini-services/terminus-control/src/index.ts
  -> durable turn admission / task contract load
  -> agentLoop(turnId)
  -> turn state PENDING -> CONTEXT_COMPILING
  -> context artifact load + provider selection
  -> ContextStateBuilder + Context Compiler
  -> ContextStore persists manifest and rendered request
  -> canonical provider-attempt fingerprint + kernel idempotency key
  -> ProviderSessionService.beginAttempt / execute / settleResponse
  -> CodingTurnEngine
  -> ToolEpisodeService -> policy/effect settlement -> kernel RPC
  -> provider continuation
  -> final provider projection
  -> `completion.proposed` artifact/event
  -> turn RESPONSE_VALIDATING -> VERIFYING
  -> VerificationCoordinator -> VerificationRuntime -> kernel predicates
  -> verification plan/results/evidence persisted
  -> completion record persisted as `PREPARED`
  -> candidate branch registered and admitted
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

Cancellation path:

```text
task/turn cancel request
  -> mutation-lock transaction emits `turn.aborted`
  -> every active or REPAIR_PENDING turn is durably ABORTED
  -> turn AbortController reaches compaction/provider/tools/process/verification
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
| `Context Compiler` | `compileContext` in `packages/context-compiler` | live | Manifests, exact prefixes, project rules, and source hashes are retained; retrieval/cache ablation remains. |
| Provider retry/runtime | `agentLoop` and `providers/*` | live, partial | Attempt stages, canonical request fingerprint/idempotency key, native response metadata, direct-stream fallback guards, abort propagation, and one anonymous OpenCode Zen free-model completion through the kernel are proven; endpoint-level deduplication, paid-account, alternate-protocol, cache, and broader live conformance remain. |
| Verification runtime | `agentLoop` | live, post-proposal | Owns completion admission; one live plan/result/branch-admission path and DB-backed completion replay are proven, while proposal/provider/effect fault coverage and semantic plan coverage remain. |
| `VerificationRepairController` | `agentLoop` | live, partial | Cumulative budget, signatures, directive, child re-entry, parent supersession, durable lease, and DB-backed repair replay scenarios are wired; the remaining fault boundaries are open. |
| Stagnation supervisor | `/v2/orchestration/stagnation/check` | endpoint/live helper | Reconcile with engine/catalog and structured stop state. |
| Scout runner | `agentLoop` before main context | live only with explicit opt-in | `TERMINUS_ENABLE_SCOUT=1` is required; utility ledger and promotion evidence remain. |
| Model router | package/control imports | experimental unless proven | Shadow only, fixed fallback. |
| Subagents | control feature modules | experimental/default-off tests | Isolated worktrees and parent-consumption evidence. |
| Browser/desktop | endpoints or packages if present | unsupported/experimental | Do not claim governed computer use without a real loop. |
| Cron/automation | package and route inventory | unverified | Enqueue through canonical executor only. |

## Recovery boundary

Startup recovery first enumerates `STARTED`/`UNKNOWN`/`RECONCILING` effects. Each ambiguous v1 effect is atomically recorded as tool `UNKNOWN`, effect `MANUAL_REVIEW`, and `tool.settlement_unknown` with a deterministic `effect-recovery:<id>` key; no effect is retried without a trusted receipt query. Provider attempts publish a canonical fingerprint and unique kernel idempotency key before dispatch, with native request and continuation IDs retained when returned. It then resumes PENDING/CONTEXT_COMPILING/REPAIRING and settled TOOL_SETTLEMENT work when provider/effect state is unambiguous. Prepared completion records are reconciled only when their candidate branch is `ADMITTED`; a matching VERIFYING task/turn is completed through the coordinator without provider replay, and unsafe intents are quarantined. A valid PREPARED checkpoint tied to a completed task and FINALIZING/VERIFIED source turn is deferred until terminal recovery can commit checkpoint and terminal rows/events together. Verified/finalizing turns require a completed task, a `COMMITTED` completion record, and proposal response artifact; otherwise recovery emits `turn.recovery_failed` and blocks the task. RESPONSE_VALIDATING and VERIFYING without an admitted completion intent are deliberately not replayed blindly and need a separate durable continuation slice.

The graph is a source-level map, not proof of runtime completion. Proof is in `EVIDENCE.md` and must be extended with live provider, crash/replay, cross-platform, client, and release observations.

# Terminus harness / turn-pipeline audit — HEAD `c2cd9d5` (2026-08-29)

Subagent: claude-opus-5[1m]. `ct/` = `mini-services/terminus-control/src/`.

## (A) Prior-finding status at HEAD

| ID | Finding | Status | Evidence |
|---|---|---|---|
| C1 | read-after-write denied by idempotency gate | FIXED | `ct/agent-tools.ts:773` reads exempt; gate `ct/index.ts:13849`; denial text `agent-tools.ts:798-812` |
| C2 | verification hardcodes `just <recipe>` | FIXED | `ct/verification-runtime.ts:231-273` uses `discoverVerificationRunners` (`repository-signals.ts:439-466`); no runner ⇒ `skipped` ⇒ COMPLETED `ct/index.ts:16836-16938` |
| C3 | every task gets DETERMINISTIC_TEST | FIXED (different mechanism) | `turnMayHaveChangedWorkspace` `:15014,16294`; no-change turn completes `:16596-16617`. `gateway.ts:21-29` fix has no production caller; `apps/desktop/src/lib/api-v2.ts:759` still hardcodes DETERMINISTIC_TEST |
| C4 | retry classifier regex | FIXED | `provider-retry.ts:50-67,97,108-114` structured `ProviderTransportError` |
| C5 | gateway discovery cache | FIXED | persisted `:12545-12557`, warmed `:12606`, on-miss `:12566-12590` |
| C6 | startup recovery before bind | FIXED | listen `:19285`; recovery in callback `:19310` |
| C7 | no gRPC deadline | FIXED | `kernel-uds.ts:62-65,97-100`, `kernel-mtls.ts:81-86`, `kernel-deadlines.ts`; kernel `DeadlineLayer` `grpc.rs:3294,3441` |
| C8 | kernel drops KernelError detail | FIXED (write-only) | `grpc.rs:3003-3029`; no TS reader for `terminus-error-bin/-code` |
| C9 | `details: {}` | FIXED | `loop-contracts.ts:309,165-195,240-261` |
| C10 | split terminal txs | PARTIAL | `emitAtomicBatch` `:17457-17475`; turn still fire-and-forget `:6390`, 201 before work `:6393`; `shutdownControl` `:19321` never aborts in-flight turns |
| C11 | `truncated_tool_calls` unhandled | PARTIAL | engine guard `coding-turn-engine.ts:336-341`; stop switch `:16382-16424` has no case/default ⇒ ToolCycleBudgetExhaustedError `:16428`. No renderer emits finishReason "length" |
| C12 | exec timeout undefined | FIXED | `:7236,7293`; `grpc.rs:2476-2489`; `manager.rs:315` |
| C13 | 10s connector timeout | FIXED | `connectors.rs:25-30` (300s/60s idle); `openai-compatible` PerGrant contributes no L4 host (`connectors.rs:186`, `broker.rs:214`) |
| C14 | orphaned ACTIVE tasks | FIXED | `reconcileOrphanedActiveTasks` `:18651` |
| C15 | packaged migrations | FIXED | `migrations/control-runtime.ts:46-58` |
| C16 | TERMINUS_DIRECT_PROVIDER_JSON unreachable | OPEN | `apps/desktop/electron/runtime-supervisor.ts:539-553` closed env; also drops TERMINUS_ENABLE_SCOUT, _MAX_TOOL_CYCLES, _TURN_MAX_STEPS, _ACTIVE_TOOL_CAPABILITIES, _SHELL_MODE, _MAX_REPAIR_ATTEMPTS |
| C17 | models.dev raw fetch | OPEN | `provider-models.ts:261,269`; callers `:12810,12913` pass no fetchFn |
| C18 | latencyMs 0 | FIXED | `provider-stream-coalescer.ts:141-162`; `:11181,15428`; persisted `:16214` |
| C19 | 500s without trace id | FIXED | `sendInternalError` `:2655-2675` |
| C20 | verification timeout_ms ignored | FIXED | `standard-predicates.ts:137` → `verification-runtime.ts:180,358-362` |
| C21 | malformed scout args | FIXED | `parseArguments` `agent-tools.ts:719-734`; `:13667` |

P0/P1: steering FIXED (`POST /v1/turns/:id/steer` `:6459`; drained `coding-turn-engine.ts:271,347`). Streaming FIXED (gateway `ExecuteStream` `gateway-kernel-client.ts:186-219`). Compaction N+1 PARTIAL (`:15061-15086`, O(new)/attempt via cache `:14361`; byteSize not persisted; failure cached as 0 `:15083-15085`). Evidence ceremony OPEN (`coding-turn-engine.ts:576-638`; persisted per call `:15964-15976`). Cache discipline PARTIAL (`promptCacheKey: epochId` `:15412`; CacheRatioMonitor `:15715,16144`; no footer). Loop guards FIXED a–d, no verification nudge. Rate limit PARTIAL (retry-after never converted `gateway-kernel-client.ts:230-233`; CircuitBreaker never fed; rateLimitGroup unread `turn-budget.ts:218-263`).

## (B) Per-tool-call cost

Path: `POST /v1/turns` `:6095` → admission `:6205-6289` → ingest/link `:6308,6322` → `admitUnderMutationLock` `:6331` → fire-and-forget `agentLoop` `:6390` → `agentLoop` `:14340` → `git rev-parse` `:14447-14463` → `CodingTurnEngine` `:15923` → `withTurnDeadline(engine.run())` `:16380` → compile `:15039` → beginAttempt `:16030` → executeProvider `:16057` (direct `:15388` / gateway `:11138`) → settleResponse `:16092` → settleToolCall `:16257` → `settleStandaloneProviderTool` `:13777` → afterToolsSettled `:16330` → stop switch `:16382` → verification `:16617` → finalizeTurn `:16476`.

ONE `read` = 12 sequential kernel RPCs + 5 write transactions:
1 `process.Start git rev-parse` (before) `:13794`; 2–3 `artifacts.Ingest`×2 `:13804,13809`; 4–5 `Link`×2 `:13813,13814`; 6 `MintTaskCapability` (key includes exact path ⇒ cold per new file) `:1449,1401-1414`; 7 `files.Read` `agent-tools.ts:1133`; 8 `git rev-parse` (after) `:14107`; 9–12 Ingest/Link ×4 `:14221,14225,14247,14251`.
DB: tool.proposed `:13815`, authorize `:14006→3580`, start `:14019→3611`, settle `:14258→3677`, observation+ledger `:15964→11511`; each a `$transaction` with `lease.updateMany` (`:908-932`) + `semanticEvent.create`; ≈5 tx / ~18 row writes, serialized on global `mutationMutex` `:1916-1920`.
ONE `patch` = same + `sideEffect.findUnique` `:13849`.

Per attempt: `loadModelVisibleEpisodes` re-fetches every in-window episode artifact (`tool-episode-service.ts:126`), twice on compaction (`:15040,15139`); `discoverRepositorySignals` 16 `files.Read` + repo-map `:15193`; `loadRepositoryInstructionFragments` `:15235,11948`; one `artifacts.Ingest` per context fragment (`context-store.ts:403-418`) incl. omitted; baseline `:15298`; response/message ingests `:16175,16183`. ≈2k+25+F sequential RPCs at step k — quadratic in turn length.

## (C) New findings (ranked)

1. grep/glob/exec_poll implemented but never offered: `selectStandaloneToolSchemas` (`agent-tools.ts:575-582`) filtered by `TERMINUS_MINIMAL_TOOL_IDS=["read","patch","exec"]` (`:14810,14818`; `minimal-profile.ts:8`); exec schema advertises `exec_poll` (`agent-tools.ts:448`, `poll_hint` `:1404`) ⇒ backgrounded jobs unrecoverable. Fix: derive `declaredToolIds` from `activeToolSchemas`.
2. Contradictory tool inventories in errors: `STANDALONE_TOOL_IDS_FOR_MODEL` (`agent-tools.ts:714`) lists 6+, not-offered rejection `:16278` lists 3.
3. Failed mutation blocks its own retry: gate matches row existence, no state filter (`:13849-13856`); row created at authorize `:3594`, never removed. PATCH_STALE_SOURCE retry ⇒ "already applied … Do not retry". Fix: gate only on STARTED/SETTLED/UNKNOWN.
4. Repeated exec denied as duplicate: `sideEffectClass:"process"` (`agent-tools.ts:933`) ⇒ gate applies; hash `{taskId,contractVersion,toolId,args}` `:736-748` task-scoped ⇒ `exec cargo test` denied after first run. Breaks edit→test→edit. Fix: exempt process class or key on workspace revision.
5. One failing exec/grep/glob kills the turn: no try/catch `agent-tools.ts:1414,1440`; non-read ⇒ `markUnknown` + AmbiguousToolSettlementError `:14086-14096` ⇒ INTERRUPTED. patch does it right `:1296`.
6. Two sandboxed `git rev-parse HEAD` per tool call `:13794,14107`. Cache per turn, invalidate after mutating call.
7. One artifact ingest per context fragment per attempt `context-store.ts:403-418`.
8. Full history re-hydration from kernel per attempt `tool-episode-service.ts:126`; no turn-scoped content map.
9. Durable tx per 64 chars of streamed text: `PROVIDER_DELTA_FLUSH_CHARS=64`/50ms (`provider-stream-coalescer.ts:24-25`); each delta = semanticEvent.create + lease UPDATE (`:11194-11205→1710`) under global mutex. 40k-char response ≈ 600 tx.
10. Process-global `mutationMutex` `:1916-1920` serializes all turns; parallel read batch collapses to serial.
11. Unbounded fan-out: no concurrency cap in `planToolExecution`; 200 reads ⇒ 400 concurrent git spawns.
12. `truncated_tool_calls` reclassified as BUDGET_EXHAUSTED `:16382-16428`.
13. retry-after discarded then clamped to 8s (`gateway-kernel-client.ts:230-233`; `provider-retry.ts:230-232`).
14. Compaction preflight caches failures as 0 `:15083-15085`; corrective re-read only past threshold `:15098-15115`.
15. `withTurnDeadline` covers only engine.run `:16380`; pre/post work gets 30-min ceiling (`kernel-deadlines.ts:26`).
16. Shutdown abandons in-flight turns `:19321-19338`.
17. Kernel error metadata write-only (`grpc.rs:3005-3029`; nothing reads it).
18. Dead: `agent/subagents.ts`; unreachable: `scout-runner.ts` (gated on `subagentsEnabled` hardcoded false `minimal-profile.ts:74,38`); `public-api/gateway.ts:21-29` no caller.
19. Exec output tail-only `agent-tools.ts:1613 tailOf`; no head/tail split.

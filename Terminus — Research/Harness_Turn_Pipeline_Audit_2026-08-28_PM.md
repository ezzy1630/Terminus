# Terminus Harness — Turn Pipeline Failure Analysis (2026-08-28 PM)

Evidence: `.terminus-dev/control.db`. **Zero `turn.completed` events ever recorded.** 10 FAILED / 1 ABORTED turns, seven distinct causes all flattened to `code: PROVIDER_EXECUTION_FAILED, reason: agent_loop_error, details: {}`:
- `no kernel-brokered provider transport is configured for 'local'` (no provider configured → silent fallthrough)
- `required context blocked by confidentiality policy: …authority:platform-authority…`
- `3 INVALID_ARGUMENT: kernel request failed` (artifact-link allowlist — fixed in uncommitted services.rs, needs kernel rebuild)
- `Value … does not fit in an INT column` (repair_attempts.created_at — fixed by migration 0021)
- `configured gateway model … has no admitted discovery record` (discovery cache is process-memory, warmed only by GET /v1/provider-models)
- `[502] Upstream error from Nvidia` after 1 attempt (retry classifier regex `/HTTP (\d{3})/` doesn't match gateway error text)
- `coding loop stopped with doom_loop` (read-after-write denied as duplicate → model retries → guard fires; the patch had already landed)

## Blockers
- **C1 read-after-write denied.** `agent-tools.ts:557-569` dedupe hash omits workspace state; gate at `index.ts:12018-12037` treats `read` (sideEffectClass read, cacheable, workspace_snapshot) like a mutating effect. Fix: exclude reads from the idempotency gate or key on workspace revision; make denial text actionable.
- **C2 verification hardcodes `just <recipe>`** (`verification-runtime.ts:166-182`, `void paths`). Any repo without a justfile fails verification → 2 repair turns → FAILED_VERIFICATION. Derive from `repository-signals.ts`; no runner → `skipped`.
- **C3 every task gets `DETERMINISTIC_TEST` criterion** (`packages/public-api/src/gateway.ts:34,63`) — chat turns can never complete. Plain assistant text is converted to `blocked/COMPLETION_PROPOSAL_REQUIRED` (`index.ts:14302-14320`).
- **C4 retry classifier** (`provider-retry.ts:29-31`) — carry structured status on the error.
- **C5 gateway discovery cache** (`provider-models.ts:64-68`, read cache-only at `index.ts:12741`) — persist or warm at startup or discover on miss.
- **C6 startup re-drives turns before bind** (`index.ts:16360` `await agentLoop` in pre-bind block; `server.listen` at `:16917`; recovery failure throws at module scope). Bind first; mark orphaned turns terminal with `control plane restarted`.

## Major
- C7 no gRPC deadline anywhere (`kernel-uds.ts:61`, `kernel-mtls.ts:78`, `index.ts:1234` deadline undefined) → kernel enforcement at `services.rs:495-506` is dead code.
- C8 kernel drops `KernelError` detail on gRPC (`grpc.rs:2818` `"kernel request failed"`); HTTP path (`error.rs:52-77`) preserves it. One-line fix.
- C9 `details: {}` for every non-ForgeError (`loop-contracts.ts:228`); grpc-js numeric `code` fails the string guard at `:191` → everything classifies INTERNAL.
- C10 turn-terminal and task-terminal writes are two transactions (`index.ts:15199-15243`, `:15271-15303`); `updateTaskAndTurn` (`:11856`) used only on the happy path. Turn launched fire-and-forget (`:5851`), 201 returned before work; shutdown doesn't settle in-flight turns.
- C11 `truncated_tool_calls` unhandled in `index.ts:14302-14346` (moot: no renderer emits `finishReason: "length"`).
- C12 `/v1/tools/exec|job` send `timeout: undefined` → unbounded process (`grpc.rs:2289`, `manager.rs:313`).
- C13 anthropic/openai connectors inherit 10s total-duration timeout (`services.rs:280-297`, `broker.rs:82`, wraps whole stream at `:393`); hosts not in default egress allowlist (`services.rs:109-113` only opencode.ai).
- C14 orphaned ACTIVE tasks with zero turns invisible to recovery (`POST /v1/tasks/:id/start` sets ACTIVE without a turn).
- C15 packaged bundle ships 0001-0020; exact-inventory check blocks dropping 0021 in; one-way door (`migrations/control-runtime.ts:62-66`).

## Minor
C16 `TERMINUS_DIRECT_PROVIDER_JSON` unreachable (dev-stack and supervisor build closed env allowlists). C17 models.dev fetched with raw `fetch` outside the kernel (`provider-models.ts:177-188`); offline snapshot has fixture Zen ids. C18 `latencyMs: 0`/TTFT null (`index.ts:13382` discards `nativeResult.usage`). C19 generic 500s without trace id (`:5492`, `:6688`, `:16691`). C20 verification `timeout_ms` ignored (`verification-runtime.ts:265` hardcodes 1800s). C21 malformed scout args → `{}` executed (`index.ts:13795`).

## Answers
- Streaming: `turn.provider_text_delta {text}` at `index.ts:10460-10488`; direct transport streams (`ExecuteStream`), gateway transport does **not** (unary `Execute`, `gateway-kernel-client.ts:60`, re-sliced buffer); 512-char coalescing.
- Steering: stored as episode, consumed only when `toolCalls.length === 0` (`coding-turn-engine.ts:303-313`) — not between tool batches.
- Interrupt: real AbortController on direct path; gateway unary not cancelled; retry sleep ignores signal.
- Guards: doom loop present+tested; JSON repair present; length-stop unreachable; empty-response guard absent (`no_final_response` declared never constructed); repetition guard absent.
- Efficiency: ~11 sequential kernel RPCs per tool call (4 ingest + 4 link sequential, 2 `git rev-parse`, tool RPC). Prompt caching ineffective: `cachedInputTokens: 0` everywhere, `cache_ratio_observed ratio: 0`. Compaction preflight cache poisons itself on one transient failure (`index.ts:13044-13061`).
- Local NDJSON provider: real (`provider-command.ts`, `terminus.local-provider.v1`), sample in `scripts/e2e/deterministic.sh:80-92`, no streaming.

## Solid — don't touch
The three uncommitted fixes (verified against all 14 `.link(` call sites; `context-store.test.ts` 2/2). Migration machinery. Packaged runtime supervisor (manifest digest chain, fd-3 readiness nonce). Lease CAS fencing. SSE transport (heartbeat, backpressure, bounded buffers). Kernel process-timeout enforcement (`manager.rs:313-324`). Doom-loop guard and JSON repair.

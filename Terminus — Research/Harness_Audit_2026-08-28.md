# Terminus Harness Audit & Ranked Roadmap — 2026-08-28 (HEAD 425e6c1)

Method: full-repo source audit (loop, context, providers, ACI, kernel, UX, evals/CI), live test runs (`cargo test --workspace`, `bun test` cohorts, `just check`), plus first-party source deep-dives of pi (earendil-works), openai/codex (codex-rs), NousResearch/hermes-agent, Gen-Verse/Recuris, xai-org/grok-build. All claims below carry file:line evidence in this repo.

---

## PART 1 — STATE OF TERMINUS AT HEAD

### 1.1 What is genuinely working (verified by test run + code trace)

| Subsystem | Evidence | Verdict |
|---|---|---|
| Agent loop | `mini-services/terminus-control/src/agent/coding-turn-engine.ts` (529 LOC): bounded loop, parallel read-tool batching with deterministic ordering, doom-loop detection (3 identical tool signatures), hard 24-step budget, abort at 5 checkpoints, policy/budget/needs-user stop taxonomy. Wired to durable SQLite in `index.ts:13693–13960`. | Real |
| Context Compiler | `packages/context-compiler` (8.7k LOC): manifest assembly, authority precedence (platform > org policy > task > AGENTS.md > skills > retrieved content), byte-stable prefix hashing (`cache-debug.ts:50–240`), utility-per-token greedy allocation with dependency closure, provider-aware budgets (`budget-policy.ts:36–100`). | Real |
| Compaction | `agent/compaction-service.ts` (746 LOC): deterministic prune planning + one structured LLM summary, episode-paired pruning, summarizer calls bypass cache writes. **Auto-triggered per turn** at 96k-token threshold (`index.ts:12824, 12854`). | Real (corrects earlier audit claim of "not invoked") |
| Provider layer | SSE decoders for Anthropic/OpenAI with incremental tool-arg assembly (`provider-anthropic/src/stream.ts:81–162`, `provider-openai/src/stream.ts:75–200`); explicit `cache_control` breakpoints with stable-prefix-hash invalidation (`provider-anthropic/src/index.ts:197–226`); canonical chunk schema; exact bigint cost accounting; **exponential backoff + jitter retry exists** at `mini-services/.../providers/provider-retry.ts` (corrects "no retry" audit claim). | Real |
| ACI | 7-tool surface: `read` (modes, continuation tokens, mandatory elision markers), `search` (hybrid ripgrep/BM25/LSP/TreeSitter + facets), `patch` (transactional, observed-hash anchors, rollback), `exec`/`job` (bounded output, artifact spill), `inspect` (LSP ops), `capability` (progressive disclosure). No silent truncation — enforced in `aci/truncation_elision.test.ts`. MCP relay real (`capability-registry/src/mcp_relay.ts`) with env sanitization + trust labels. | Real, strongest area |
| Rust kernel | 13 service groups; bearer + capability-token authz on every request (`mini-services/terminus-kernel/src/auth.rs`); bwrap sandbox real on Linux (`terminus-sandbox-linux`, 1,122 LOC); strictest-wins policy engine; patch transactions; secret broker; 687-LOC non-bypassability test suite. Workspace lints deny `unwrap/expect/panic`. | Real (Linux); macOS unproven |
| Verification | `packages/verification` (6.8k LOC): acceptance-predicate DAG, completion gate, proof bundles, changed-code invalidation. | Real |
| Evals machinery | `python/forge_evals` (17.5k LOC first-party): real graders, SWE-bench Verified + Terminal-bench adapters, paired bootstrap statistics, promotion gates. | Real machinery |
| CI | 13 required PR gates incl. live bwrap adversarial smoke, buf proto-breaking, standalone-check, 5-OS matrix. | Real |
| Clients | TUI (streaming, resume, approvals, mouse) + Desktop Electron (virtualized streaming feed) + JSON CLI + IDE-ACP adapter. | Real, sparse |

Test evidence (run during audit): `cargo test --workspace` → **438 passed, 0 failed**. `bun test` on task-runtime/orchestration/context-compiler/aci/provider-anthropic → **378 pass, 7 fail** (all 7 are the in-flight Cockpit deletions in the dirty worktree, not HEAD). `just check` fails only on fmt drift in WIP `crates/terminus-kernel/src/services.rs`. One flaky test at HEAD: `terminus-process::manager::tests::cancel_running_process` (races spawn→`is_running` under load; did not reproduce in the second full run).

### 1.2 What is missing, stubbed, or broken

1. **Zero live benchmark runs. Ever.** `python/evals/results/smoke/runs.jsonl` is 84 fixture runs against a fake model with noop graders; `results/full/` is empty; SWE-bench Verified (500 tasks) and Terminal-bench (89 tasks) adapters are wired but never executed against a live provider. The maturity registry honestly admits 0/59 components are production. **This is the existential gap.** A harness with no baseline number cannot claim — or even measure — progress.
2. **No steering.** Only a hard interrupt exists (`index.ts:5830–5852` `/v1/turns/:id/interrupt` → abort). There is no queue that injects user guidance between tool batches without killing the turn (pi: `PendingMessageQueue` polled per turn; codex: drains pending input inside `run_turn`). Every competitor supports this; interactive correction is table stakes.
3. **No streaming to the client during provider calls.** `executeProvider` collects the full chunk stream before settlement (`native-provider-runtime.ts:112–120`); UI gets nothing until a response completes. TTFT is recorded (`UsageRecord.timeToFirstTokenMs`) but never streamed or displayed.
4. **Compaction trigger is an N+1 RPC scan.** `index.ts:12808–12821` loops over every episode making one sequential kernel `GetMetadata` RPC per artifact, per attempt, even when no compaction will trigger. On a 300-episode turn that is 300 round-trips before every provider call.
5. **Per-tool evidence ceremony.** Every tool call builds a full `OperationObservation` (hypothesisId, criterionIds, workspace revisions, verificationDelta — `coding-turn-engine.ts:477–540`). Unproven eval value; pure latency/complexity cost on the hot path.
6. **Tool-surface gaps vs. model training prior:** no `grep`/`glob`-shaped primitives (models are massively trained on rg-shaped tools; the novel faceted `search` API costs failed calls), no web search, no subagent tool exposed to the model, no plan/todo tool (codex `update_plan` with enforced single-in-progress-step is a proven benchmark aid), no `get_context_remaining`.
7. **UX telemetry absent.** No token count, cost, or cache-hit rate shown in TUI or Desktop; no markdown rendering; no image paste; no diff viewer. pi shows live cache-hit-rate + cost in a footer.
8. **macOS sandbox unproven** — and the dev machine is macOS. Seatbelt profiles exist but have "no current candidate-bound conformance evidence" (maturity.yaml).
9. **Reliability guards absent at loop level:** no repetition guard (hermes: 60+-char verbatim window ×5 ⇒ abort), no empty-response guard, no length-stop fail-don't-execute for truncated tool calls (pi fails all tool calls from a `"length"`-stopped message; Terminus would execute salvaged args), no JSON repair of malformed tool args.
10. **Rate limiting declared, not enforced**: `rateLimitGroup` in `turn-budget.ts:71` is unused by `planToolExecution`; no 429 → CircuitBreaker feed.
11. **Memory disabled** (no durable backend, not integrated into compile flow — exit gate can't run because no live evals exist to pass it: circular blockage).
12. **In-flight Cockpit refactor** leaves 7 failing TS tests + fmt drift in the worktree (uncommitted; HEAD itself is green).
13. **Windows sandbox and microVM are stubs** (documented, honest). Extension runtime WASI stub. 4 of 5 external adapters are stubs.

### 1.3 Cross-harness mechanism review (what the leaders actually do)

**pi** (`packages/agent/src/agent-loop.ts`): hook-contract loop (`convertToLlm`, `getSteeringMessages`, `prepareNextTurn` injected); steering queue polled per turn; tiny system prompt (~60 lines, tool-adaptive guidance); skills as name+description only (loaded on demand via read); single `cache_control` breakpoint on last-user-message + last tool def; session-affinity IDs (`prompt_cache_key`, `x-session-id`); live cache-hit-rate footer; fail-don't-execute on length stop; JSON repair; retryable-error regex classifier with backoff; truncation-with-continuation contract (head for reads, tail for bash, spill to temp file); compaction only at user/turn boundaries + stale-usage guards.

**codex-rs** (`core/src/session/turn.rs`): two-level turn loop draining pending input; per-model instruction templates (`model_instructions/gpt-5.2-codex_instructions_template.md`); three auto-compaction triggers (manual, pre-sampling, mid-turn inline) with model-trained summary placement; `prompt_cache_key` per thread; WebSocket reuse + session prewarm; unified exec PTY with `yield_time_ms`/`max_output_tokens` (model controls polling); 1 MiB exec cap with **50/50 head/tail buffer**; explicit truncation warnings always surfaced; `update_plan` with schema-enforced single in_progress step; `apply_patch` verified via LRF grammar; sandbox escalation-on-failure flow (no approval stalls); `get_context_remaining`.

**hermes-agent** (`agent/conversation_loop.py`, 8,650 lines): incident-numbered failure-mode guards — repetition guard, deterministic-empty guard (2 empty completions ⇒ fallback chain; expensive retries get budget cut), iteration budget with refunds, **verification nudge** (blocks finish right after code edit without fresh evidence); three-tier byte-stable system prompt (stable/context/volatile) never re-rendered mid-session; frozen memory snapshots injected at session start; 4-breakpoint Anthropic cache plan with builder-declared stable-prefix boundaries; micro-compaction (fold one oldest exchange per turn, never user messages); 9-strategy fuzzy edit matching; 40/60 head/tail terminal output; shadow-git file checkpoints.

**Recuris** (not a coding harness; self-improvement framework): harness-only write authority for DONE/termination (model cannot write its own completion without a real tool receipt); paired bootstrap gate over **items not trials**; leakage checks; fingerprint verification that the credited mechanism actually fired; activation probe (static "does this context reach the model" wiring check). Terminus's completion-proposal → verifier-admission path already embodies the first idea — the others belong in forge_evals.

**grok-build** (xai-grok, Rust): hashline edit scheme with `AnchorScheme`/`CheckpointChain` and its own **edit-scheme benchmark**; kernel write-denies its own hook sources (anti-persistence); symlinked `$GROK_HOME` refuses sandbox start; "dream" memory consolidation gated on time/session thresholds with locks + rollback; side-calls engineered to ride the parent prompt-cache key; codebase scope graph; doom-loop telemetry (admittedly not yet acting on it).

---

## PART 2 — RANKED ROADMAP

### P0 — Prove the thing works (blocking everything else)

1. **Live eval end-to-end.** Wire a real provider credential through the kernel connector (the one remaining program gate the worklog names), run SWE-bench Verified (start: 50-task stratified slice) + Terminal-bench mini split + the 12 internal tasks live. Produce the first honest baseline: pass rate, tokens/task, cost/task, cache hit rate, TTFT. Everything below is judged against this number. Owner: `python/forge_evals/runners/live_runner.py` + `evals/registry.yaml`; CI: `live-eval` workflow exists, needs secret.
2. **Land the worktree.** Commit or discard the Cockpit refactor: 7 failing tests, fmt drift in `services.rs`. HEAD must be green before any measured change.
3. **Add steering.** New `PendingMessageQueue`-style dependency in `CodingTurnEngine` (check `signal` + queue at each loop top, after each tool batch); expose `POST /v1/turns/:id/messages` that enqueues without aborting. Test: steer mid-turn, assert the next provider request contains the injected message.
4. **Stream to clients.** Pipe `ProviderResponseChunk`s from `native-provider-runtime` through the durable event stream (SSE) to TUI/Desktop as they arrive; keep settlement atomic. Surface TTFT live.

### P1 — Tokens, cost, latency (the efficiency objective)

5. **Fix the compaction-trigger N+1** (`index.ts:12808`): batch artifact-metadata lookup into one kernel RPC (or persist episode byteSize on the episode row at write time — simplest, zero RPC). 
6. **Sample the evidence ceremony**: make `operationContext`/`onOperationObserved` opt-in per effect class (keep for writes; drop for reads). Measure before/after on eval tokens.
7. **Cache discipline**: adopt pi's placement — verify breakpoints land on last tool def + last user message; add session-affinity `prompt_cache_key` for OpenAI-compatible providers; add a live cache-hit-rate + cost footer (pi's `cache-stats.ts` is the reference).
8. **Loop guards**: (a) length-stop ⇒ fail all tool calls in that message without executing (pi `failToolCallsFromTruncatedMessage`); (b) JSON repair on malformed tool args; (c) repetition guard (verbatim-window detection); (d) empty-response guard with fallback; (e) verification nudge — already half-built: the verification-repair-controller exists (`verification-repair-controller.ts`), extend to block finish-after-edit without fresh evidence.
9. **Rate-limit closure**: parse 429/`retry-after` in `provider-retry.ts`, feed `CircuitBreaker.recordFailure()`, enforce `rateLimitGroup` in `planToolExecution`.

### P2 — ACI (coding quality per token)

10. **Expose `grep` and `glob` primitives** as kernel-dispatched ripgrep/file-enumeration (description-heavy, rg-shaped). Keep `search` as the smart hybrid. A/B on the eval cohort.
11. **Plan tool**: `update_plan`-equivalent with schema-enforced single in-progress step; wire into Desktop MissionBoard.
12. **Head/tail exec buffer**: replace pure-tail truncation of exec output with 40/60 or 50/50 split (hermes/codex both converge on this; error heads matter).
13. **Fuzzy patch fallback**: on `ANCHOR_AMBIGUOUS`/stale, run hermes-style whitespace-normalized matching chain before failing, return the match for confirmation.
14. **`context_remaining` tool** (codex) — cheap, prevents over-context guessing.
15. **Per-model system-prompt profiles** (codex `model_instructions/` pattern): at minimum a Codex-family variant; keep the 1,600-token authority prefix contract.

### P3 — Systems & platform

16. **macOS Seatbelt conformance evidence** (this machine): candidate-bound adversarial fixtures mirroring the bwrap CI job; then non-bypassability TS-side fixtures (`tests/security/bypass/` is empty).
17. **Connection reuse/prewarm** (codex WebSocket reuse + session prewarm); batch tool-result artifact writes.
18. **Memory integration behind the exit gate** — now unblocked once P0-1 produces live runs to pass the precision/harm gate. Start with hermes's frozen-snapshot injection (cache-preserving) before anything dynamic.
19. **Adopt Recuris's paired bootstrap gate over items (not trials) + leakage + fingerprint checks in forge_evals promotion gate** (stats package already has bootstrap/noninferiority — add the item-level pairing + activation-probe equivalent for context fragments).
20. Subagent tool exposed to the model behind the EV scheduler (`orchestration/ev_scheduler.ts` exists but is not model-reachable).

### P4 — UI

21. Markdown rendering in TUI (fenced code + lists minimum), image paste in Desktop Composer, plan-diff viewer, token/cost/cache inspector panel in Desktop Inspector.
22. Cockpit refactor completion (in flight): the deleted views (WorldState, EffectQueue, ClaimEvidenceGraph…) should reappear fed by the durable event stream, or stay deleted deliberately — decide and document.

---

## PART 3 — DESIGN DECISIONS TO CHALLENGE

1. **Per-tool-call durable observation ceremony.** The SPEC treats every tool call as evidence. Benchmarks grade final patches and tests, not hypothesis ledgers. Keep durable evidence for *writes and external effects*; make read-path observation free. This is the single biggest unforced complexity tax in the loop.
2. **7-tool minimalism without rg-shaped primitives.** Minimalism is defensible (pi agrees), but pi ships `bash` which can run `rg`. Terminus's exec is sandboxed and network-allowlisted — still fine — yet the *tool schema surface* is novel where models are priors-trained on `grep`/`glob`/`edit`/`write`. Novel ACI = failed calls = burned tokens. The `search` tool's facet API should be *layered on top of* familiar primitives, not instead of them.
3. **Kernel RPC per tool call.** Architecturally pure; latency unknown (no kernel benchmark exists — maturity.yaml confirms none). Before optimizing anything else, measure per-call RPC overhead (authz + policy + settlement + observation = 3–5 round-trips/tool?). If >10ms/call, add a kernel-side batching/pipelining mode for read classes.
4. **9,647-line SPEC + 0 live evals.** The spec-to-evidence ratio is inverted. The maturity registry's honesty is good governance, but the Phase-0 discipline ("nothing is production until signed evidence") has ossified into a system where the eval machinery is excellent and unused. Flip the ratio: a live baseline unlocks promotion gates for everything else.
5. **Memory exit-gated on evals that never run** — circular. Resolve via P0-1.
6. **Completion-by-proposal.** The `completion_proposal` + verifier admission path (Recuris-convergent) is right — but verify it doesn't trap benign tasks: `EngineStop` taxonomy has 13 variants; any that dump the user to `needs_user_input` too eagerly will show up as benchmark stalls. Instrument stop-reason frequency in the first live runs.

## PART 4 — VERIFIED HEALTH BASELINE (2026-08-28)

- `cargo test --workspace`: 438 pass / 0 fail (1 flaky: `cancel_running_process` spawn race — add a `wait_for_running` poll).
- `bun test` critical cohorts: 378 pass / 7 fail (worktree-only, Cockpit deletions).
- `just check`: fails on WIP fmt drift + those tests; HEAD commits are green per CI (workflow run 32747525109 referenced in worklog).
- Release gate: intentionally FAILED (fixture-tier evals, no owner signatures) — honest.
- Known flake fix: `crates/terminus-process/src/manager.rs:1587` — replace immediate `assert!(mgr.is_running(...))` with a bounded poll loop.

## PART 5 — IMMEDIATE NEXT SESSION CHECKLIST

1. `git status` triage: commit Cockpit refactor or stash; make `just check` green.
2. Fix `cancel_running_process` flake (bounded poll).
3. Stand up live provider credential via kernel connector → run 50-task SWE-bench Verified slice → record baseline in `artifacts/` + `evals/results/full/`.
4. Implement steering queue in `CodingTurnEngine` + endpoint + test.
5. Batch compaction metadata (persist `byteSize` on episode rows).
6. Length-stop fail-don't-execute + repetition guard in engine.

# Terminus Harness — Full Audit Synthesis and Upgrade Proposal

**Date:** 2026-08-29 · **HEAD:** `c2cd9d5` (main, clean) · **Method:** six Opus 5 subagent audits + two research sub-agents, every load-bearing claim re-verified by the lead at the cited line. Detailed reports: `01_turn_pipeline.md` … `08_verification_evals.md` in this folder. Prior audits (2026-08-28) were verified, not re-derived.

---

## 0. Verdict

Terminus has a genuinely strong substrate — a non-bypassable Rust effect kernel, durable SQLite event log with lease fencing, a clean `CodingTurnEngine` with steering, doom-loop/repetition/empty/length guards, JSON repair, a three-level permission gate, provider accounts with a working ChatGPT-Codex dialect, and tolerant anchor patching. Most of yesterday's 21 blockers are fixed at HEAD.

But the **model-facing path is crippled by ~15 small, concrete defects** that no amount of architecture compensates for. Every model, on every transport, is currently driven with:

| Defect | Where | Effect |
|---|---|---|
| `max_tokens` = **1024** | `index.ts:11347` | any real patch truncates; engine then refuses truncated tool calls |
| context clamped to **32,768** | `provider-account-models.ts:517`, `direct-provider-config.ts:148`, `gateway-provider-config.ts:195` | 1M-context models get 3% of their window |
| reasoning/thinking **off** (reserve `0n`) | `index.ts:11348` → both renderers gate on `> 0n` | effort setting in UI/API is dead except on Codex |
| Anthropic renderer sends `budget_tokens` + `temperature` | `provider-anthropic/src/index.ts:95-106` | **hard 400 on Fable 5 / Opus 5** |
| `anthropic-beta`/`OpenAI-Beta` rejected by kernel | `broker.rs:714,739-748` | no Claude-5/GPT-5.6 features reachable |
| **no provider call streams** (kernel buffers credentialed bodies) | `services.rs:3094-3105` | TTFT = time-to-complete; stop button decorative |
| cancel never reaches provider | `grpc.rs:1633` | stop burns full 300 s + quota |
| **task contract dropped from every prompt** (stale-version dedupe) | `index.ts:14559` vs `context-compiler/src/index.ts:640,646` | model never sees objective / non-goals / constraints — 55/55 manifests |
| **tool results rendered before their tool calls**; user msgs as `assistant` | `context-compiler/src/index.ts:1409-1416`; `provider-openai/src/index.ts:353` | corrupt causality; 400 on strict endpoints |
| message order sorted by token size per attempt | `context-compiler/src/index.ts:1287,1352` | cache dies every attempt (`cachedInputTokens: 0`) |
| **`exec` deletes stdout/stderr on non-zero exit** | `agent-tools.ts:1837,861-870` | every failing test/tsc/rg-no-match is invisible |
| **`read` ignores `offset_line`** (kernel has no range) | `grpc.rs:857-864`, `services.rs:1252` | files > 28 KiB unreadable past the head |
| tool palette = 3 tools with unfamiliar field names; prompt advertises `grep/glob/exec_poll` which are rejected | `index.ts:14810-14818`, `system-prompt.ts:56,58` | wasted calls; no file creation; no search |
| repeated `exec` denied as duplicate (task-scoped idempotency) | `agent-tools.ts:933`, `index.ts:13849` | edit→test→edit loop breaks after first test run |
| every exec clamped to **60 s**; **24-step** hard cap | `services.rs:2314`, `profile.rs:58`; `turn-budget.ts:18` | no build/test suite completes; long tasks die |
| macOS sandbox: `/` readable, no writable dir, `PATH` without bun/node/cargo/rg, zero network; policy `match:` blocks are disjunctions so `curl`/`wget` are denied on basename alone | `profile.rs:80-83`, `lib.rs:305-315`, `services.rs:163,1703`; `rule.rs:55-138` | toolchains unreachable; secrets readable; every policy rule broader than its YAML |

Any one of these makes a benchmark run fail; together they explain why `.terminus-dev/control.db` has so few completed turns. **"Objectively best" is first a correctness problem, then a token/latency problem, then model-specific tuning.** The upside is real: three independent 2026 studies bracket harness effects at **6–24 points on a fixed model** (Harness-Bench 23.8 pp; Epoch 11–15 pp; LangChain +13.7 pp of which +9.7 from effort scheduling alone) — wider than the gap between adjacent frontier models.

A second, structural problem: **~60% of the codebase is fiction relative to the live path.** `packages/aci` (4.4k LOC), `prompts/` (7.5 KB), `schemas/tools/`, `packages/memory` (3k), `packages/orchestration` (8.8k, incl. computer use), `capability-registry` (MCP relay), `workflow-compiler`, the scout/subagent runners, and seven context-compiler modules have no production caller. Docs, ADRs, and the system prompt itself describe mechanisms the model cannot use (skills, secrets broker, approval hashes, output profiles, envelope trust fields). This costs tokens, confuses models, and — worse — confused two prior audits into rating the ACI "strongest area".

---

## 1. What is solid (keep, build on)

- **Kernel boundary + Seatbelt/bwrap backends + policy engine + capability tokens.** Real, tested on Linux; macOS profile needs fixing (below) but the mechanism works.
- **Durable substrate:** lease-fenced transactions, atomic terminal batches, startup recovery after bind, orphan reconciliation, migrations 0001–0025, SSE with backpressure.
- **`CodingTurnEngine`** (`agent/coding-turn-engine.ts`): the loop is correct and provider-neutral; steering drained at loop top and stop boundary (`POST /v1/turns/:id/steer`); parallel read batching with deterministic ordering; all four H11 guards; JSON repair wired into both decoders.
- **Permission gate** (full/auto/ask) with hash-bound approvals and denial-as-observation.
- **Provider accounts:** keyring-backed discovery, ChatGPT-Codex dialect (`chatgpt_codex.ts`) is the only path that sends effort, `parallel_tool_calls`, `prompt_cache_key`, `store:false` correctly; models.dev catalog + persisted gateway discovery.
- **Patch engine:** transactional, journaled, tolerant anchors (ADR-0046) wired; numbered-gutter stripping; kernel already implements `CreateFile/MoveFile/DeleteFile`.
- **Retry classifier** now structured (`ProviderTransportError{status,retryAfterMs,providerCode}`), kernel gRPC deadlines, structured kernel error metadata (emitted; TS doesn't read it yet).
- **Eval machinery** (`python/forge_evals`) and CI gates — machinery only; zero live runs.

---

## 2. Plan — ordered by what unblocks what

### Phase 0 — Make one real task succeed end-to-end (days, ~20 one-line-to-one-file fixes)

Each item is small; together they are the difference between "cannot complete a task" and "completes tasks".

1. **Budget:** `makeContextBudget` (`index.ts:11341`) — `output` from the model record's max output (128k for GPT-5.6/Claude 5, ≥64k at xhigh); `reasoning` derived from the selected effort; drop the `> 0n` gates in both renderers. Replace the three `Math.min(contextTokens, 32_768)` with per-family tested ceilings (Claude 5: 1M default; GPT-5.6: **270,000 hard cap** — the 272K billing cliff bills the whole request at 2× input / 1.5× output).
2. **Anthropic renderer:** `thinking: {type:"adaptive"}` (never `budget_tokens`), `output_config.effort`, no `temperature`/`top_p`; replay thinking blocks unchanged; handle `stop_reason:"refusal"` + `fallbacks:"default"`. Admit `anthropic-beta` and `OpenAI-Beta` in the connector allowlist (`connectors.rs:104-113`).
3. **OpenAI renderer:** system → `instructions`; `reasoning:{effort, summary}` unconditional, keep `xhigh`/`max` (stop `max→high` at `provider-openai/src/index.ts:124`); `text.verbosity`; `store:false` + `include:["reasoning.encrypted_content"]` + **replay reasoning items** (add `reasoning` to `OpenAiResponsesInputItem`; capture `encrypted_content` in `stream.ts:143-156`); `parallel_tool_calls`; `truncation:"auto"`; `prompt_cache_key` on every OpenAI-shaped path incl. Zen.
4. **Context compiler:** fix the task-contract `sourceVersion` mismatch (one line); after allocation, **order runtime fragments by episode sequence, never by utility**; key role on episode kind (user_message → user); collapse the 11 world-state messages into one; put a breakpoint at the end of the stable prefix and one on the last message; fix the Anthropic breakpoint index-space bug (`context-compiler:1452` vs `provider-anthropic:222`); supply `previousCacheEpoch`.
5. **Tools:** derive `declaredToolIds` from `activeToolSchemas` (`index.ts:14810`) so `grep/glob/exec_poll` ship; `exec` always returns `{exit_code, stdout, stderr}` regardless of exit; exempt `process`-class calls from the idempotency gate (or key on workspace revision) and gate mutations only on `STARTED/SETTLED/UNKNOWN`; add `write` (maps to `CreateFile`, ~30 lines); implement `ranges` in kernel `read`; update `ObservedSourceTracker` after a successful patch and seed it from the episode log at turn start.
6. **Limits:** `HARD_MAX_STEPS` 24 → 200 (Claude Code caps at 200/session); `wall_clock_ms` 60 s → honour the tool's `timeout_ms` up to 600 s / 30 min for jobs; verification node timeout 30 s (`plan-derivation.ts:188-198`) → the suite/contract budget (≥600 s) — today `cargo test`/`bun run test`/`pytest` as required verification nodes are guaranteed to time out.
6b. **Completion path:** route `completion_gate_denied` (`index.ts:17126,17145`) through repair instead of hard-failing a task whose predicates all passed; drop the kernel `instanceId` from `environmentDigest` (`verification-runtime.ts:120-131`) so a kernel restart mid-VERIFYING no longer poisons the plan permanently; canonicalize the workspace root in `materialize_workspace_profile` (`services.rs:1609-1624`) — a symlinked root (e.g. `/var/folders/…`) currently voids every Seatbelt allowance.
7. **Sandbox (macOS now, Linux by construction — `mounts.rs:283-288` binds the same nonexistent `active-worktree`):** make the workspace root the writable root minus `.git`/`.terminus`/`credentials` deny overlays, exactly as the Linux reference plan already documents (`terminus-sandbox-linux/src/lib.rs:76-105`); also give the process a writable `TMPDIR` (today `/tmp` is EPERM under Seatbelt); replace `(allow file-read* (subpath "/"))` with system dirs + workspace + explicit toolchain roots; carry the user's toolchain into `PATH` (bun/node/cargo/rg — via `.with_workspace_root` + an allowlisted toolchain profile); deny `~/.ssh`, `~/.aws`, keychain; inject `HTTP(S)_PROXY` pointing at the egress broker so `git fetch`/`bun install` work through the allowlist; make policy `match:` clauses conjunctive (`rule.rs:55-138`) with a near-miss test per rule; assert the network verdict in the two Seatbelt live tests (they compute it and never check it, and silently pass without `sandbox-exec`) and run `non_bypassability` on `macos-latest` too (the lib tests already do run there).
8. **Streaming + cancel in the kernel:** incremental redaction with a carry buffer instead of buffer-whole-body (`services.rs:3094`); hold the `JoinHandle`, `abort()` on stream drop, thread a `CancellationToken` into `dispatch_https`; pass `retry-after` into `ProviderTransportError` at the five throw sites and don't clamp an explicit hint to 8 s; add the `truncated_tool_calls` case to the stop switch.
9. **Prompt:** one source of truth (delete `prompts/authority/*.md` or load from it); remove every instruction naming a mechanism that doesn't exist; add the missing behavioural block (persistence/when to stop, parallel tool calls, verify-before-done *only for non-Claude-5*, final-message shape, read-before-edit, prefer grep over exec-ls). Target ≤ 700 tokens.
10. **Dev ergonomics:** `bun test` from the repo root pays a ~31 s directory-scan cost per invocation (bun walks `target/`; 37.7 s vs 6.2 s from a package cwd) — under load it looks like a hang; scope bun's test root or exclude `target/`. Test health at HEAD: TS 740 pass / 0 fail per-package and `bun run test:unit` from root 692 / 0 in 38.5 s; pytest 274 pass; typecheck clean; lint 0 errors / 2 warnings (generated protobuf files); `cargo test` sandbox-macos/patch/connector/process **103 pass / 0 fail / 1 ignored**, kernel **123 / 0** across lib + all 10 integration binaries (incl. `non_bypassability`, `policy_wiring`, `secret_canary_e2e`). Every suite in the repo is green at HEAD on this machine. Rust test binaries stall 1–4 min at dyld startup on this machine (a debugger/EDR notification responder — machine-level, not a repo defect).
11. **Then run one real task** on each of: Opus 5 (direct), GPT-5.6 Sol (Codex subscription), big-pickle/deepseek-v4-flash (Zen). Record success, steps, tokens, cache hit, cost. This is baseline zero.

### Phase 1 — Tool surface v2 + prompt v2 + measured caching (1–2 weeks)

- **Palette (six tools, ~1,100 tokens, every name with a training prior):** `bash {command, timeout?, run_in_background?}`, `read {file_path, offset?, limit?}` returning plain text, `edit {file_path, old_string, new_string, replace_all?}`, `write {file_path, content}`, `grep`, `glob`, plus `bash_output {id}` for background jobs and `web_fetch` declarable behind the permission profile. Keep the kernel boundary — every mapping already exists. Add per-property `description`s and (Anthropic) `input_examples` (+18 pp param accuracy in Anthropic's measurement).
- **Exec output:** 30 KiB, 50/50 head/tail with a per-stream floor and an inline `[… N bytes elided …]` marker; codex-style `max_output_tokens` per call (~10k).
- **Edit format A/B (measure, don't assume):** keep `old_string/new_string` as default; add a **hashline** dialect (per-line 2–3-char content hash gutter; stale anchors rejected) as an *ablation arm* for weak/open models — the evidence is contested (oh-my-pi: Grok Code Fast 6.7%→68.3%, Codex-Mini 60→77.5%; an independent replication found hashline 25–40 pts *worse* on Python) — and a **freeform `apply_patch` (Lark grammar, V4A)** dialect for GPT-5.6, translated into kernel patch transactions. All are dialects over the same `PatchService`. Note the replication's side-finding: fuzzy whitespace matching fired 0/134 edits — measure whether ADR-0046's tolerant anchors ever trigger before keeping them on the hot path.
- **Loop middleware that measurably moved TB-2.0 (+13.7 pp, model fixed):** pre-completion checklist (intercept the final message and force a verification pass against the task contract before COMPLETED — Terminus already has the verification coordinator; make it a gate the model sees), per-file edit-count loop detection with a reconsideration prompt (extend the doom-loop guard), startup local-context discovery (`repository-signals.ts` already does this — inject it as one compact block), and an **effort schedule** (xhigh for plan/verify, high for implement) instead of one flat effort.
- **Prompt architecture:** stable prefix (authority ≤700 · tools ≤1,250 · AGENTS.md ≤800 · skills index ≤250) → per-task contract ≤600 → per-turn block ≤800 (checkpoint, recent history, one world-state message with `steps_used/remaining`) → append-only episodes. Per-model instruction files (`model_instructions/<family>.md`, as Codex does) layered *after* the shared prefix.
- **Cache verification as a test:** an integration assertion that the second attempt of a turn shows `cache_read_input_tokens > 0` on Anthropic and `cached_tokens > 0` on OpenAI; wire `CacheRatioMonitor` to fail the eval gate below 0.7. Delete the 16–18k-token repository map (alphabetically-first 200 files, symbol extractor skips `export`) — replace with a ≤1k task-scoped path list and "use grep".
- **Telemetry the user can see:** tokens, cache-hit %, cost, TTFT in the desktop Inspector (pi-style footer).

### Phase 2 — Efficiency: RPCs, transactions, compaction (1–2 weeks)

Current cost of one `read`: **12 sequential kernel RPCs + 5 DB transactions** (two sandboxed `git rev-parse` spawns, 4 ingest + 4 link, capability mint keyed on exact path); per attempt ≈ 2k+25+F sequential RPCs (quadratic in turn length); one DB transaction per 64 streamed characters under a process-global mutex.

- Cache workspace revision per turn (invalidate after a settled mutation) → −2 spawns/call.
- Batch ingest+link into one RPC (or ingest tool episodes lazily, at attempt settlement) → −6 RPCs/call.
- Capability mint keyed on scope, not path → cold only once per task.
- Turn-scoped decoded-episode cache; skip fragment ingest when the CAS hash is already known → per-attempt cost O(new), not O(history).
- Persist `byteSize` on the episode row; delete the compaction preflight RPC loop and its poisoned-zero cache.
- Stream deltas in-memory to SSE subscribers; persist one coalesced record at attempt settlement → 600 tx → 1 per response.
- Shard `mutationMutex` by turn id.
- Make the per-tool `OperationObservation` opt-in per effect class (writes yes, reads no).
- Fix `context_headroom_exhausted` to track *current window*, not cumulative input (`turn-budget.ts:462`); make compaction insert the summary at the pruned position with authority ≥ 80; implement `recallCompaction`; add a silent-drop marker; mid-turn compaction path.
- Cap parallel read batches (8) and reject >N tool calls per response with a readable result.
- Wrap the whole `agentLoop` in `withTurnDeadline`; abort in-flight turns on shutdown.

Target after Phases 0–2: ≤4 RPCs and 1 transaction per tool call; fixed prefix ≤3k tokens; cache hit ≥80% on attempt ≥2; TTFT < 1 s on direct transports.

### Phase 3 — Model profiles (this is §3 below; 1 week per family, in parallel with Phase 2)

### Phase 4 — Capability expansion (2–4 weeks)

- **Subagents** as a model-callable tool: `spawn/wait/send/close` over the existing task/turn substrate; "fork" mode inherits the parent transcript **and its prompt cache** (Claude Code's `subagent_type:"fork"`; Codex sets `prompt_cache_key = "{source}:{parent_thread_id}"`); results as schema-validated objects, not prose; hard caps (concurrency, depth, per-session); worktree-isolated writers as the option already in the composer. Unblocks Fable 5's strongest mode (async parallel delegation) and Opus 5's over-delegation needs the cap.
- **Plan tool** (`update_plan`, single in-progress step, skipped for trivial tasks) wired to the Kanban board.
- **`get_context_remaining` / `new_context_window`** (steps and *fraction*, not a raw token countdown — Fable 5 wraps up early when shown one).
- **Skills + AGENTS.md precedence** actually loaded: skills as name+description in the prefix, body on `read`; nested AGENTS.md with a scope marker.
- **Memory** — the four declared layers stay off; ship the one-file version: `AGENTS.local.md` (or `.terminus/memory.md`) written only by an explicit `remember` tool, loaded via `DEFAULT_INSTRUCTION_FILENAMES` as a hard-required, cache-stable fragment. Fable 5 "performs notably better when it can write learnings somewhere".
- **MCP** via the existing `mcp_relay.ts` behind tool search / deferred loading (>10 tools ⇒ `tool_search_tool_bm25` + `defer_loading` on Anthropic; `tool_search` on OpenAI; a local BM25 `capability` tool for open models).
- **Computer use** — today nothing exists (`resolveTrustedComputerUseBackend()` returns `null`; no CDP/Playwright; no screenshot tool). Order of build: (1) **browser via CDP** — the Electron desktop already ships Chromium; expose a kernel-mediated `browser` connector class (navigate/click/type/snapshot/screenshot/evaluate) and render it as Anthropic's `browser_toolset_20260801` shape / OpenAI's computer-use shape / a plain tool for open models; (2) **screenshot + image input** through the same path (Opus 5 vision is high-res, coordinates map 1:1); (3) **macOS accessibility tree** (`AXUIElement`) as a typed desktop toolset before pixel-level control; (4) OSWorld-2.0-style eval before promoting. Anthropic's long-running-agent post is explicit that browser verification was what stopped false "done" claims — this is a coding-quality feature, not a side quest.

### Phase 5 — Measurement (continuous from Phase 0)

- Harbor adapter for Terminal-Bench 4.0 (the live board; reported TB-4.0 leaders: Claude Code+Opus 5 51.8%, +Fable 5 44.5%, Codex+Sol 37.3% — **unverified**: one research pass reported these, a second could not load the client-rendered board; TB-3.0 figures Opus 5 42.7 / Sol 34.6 / GLM-5.3 28.3 are from a secondary source), SWE-bench Pro, plus the 12 internal tasks. Same model, Terminus vs vendor CLI, 5 seeds, paired bootstrap over items.
- Per-run: success, steps, tool-error rate, correction turns, tokens (fresh/cached/output/reasoning), cache-hit %, cost, TTFT, wall clock, human interventions.
- Every Phase 1–4 feature lands behind an ablation flag; promotion needs a measured delta.

---

## 3. Model-specific playbooks

### 3a. OpenAI GPT-5.6 Sol / Terra / Luna

Facts (research, primary sources): three-tier family GA 2026-07-09, no separate `-codex` SKU; Sol `gpt-5.6-sol` $4/$0.40/$20, Terra $2/$0.20/$12, Luna $0.20/$0.02/$1.20; 1,050,000 ctx (922k input) / 128k output; effort `none…xhigh|max` (default **medium**); `text.verbosity`; **272K billing cliff**; caching min 1,024, `prompt_cache_options.mode="explicit"` + `prompt_cache_breakpoint`, TTL 30 m default; `service_tier: priority|fast`; hosted `shell`, `apply_patch`, `tool_search`, PTC, computer use. OpenAI measured: **leaner system prompts +10–15% eval, −41–66% tokens**.

Wire (Responses):
- `instructions` = stable prefix; `input` = task + episodes; `store:false`; `include:["reasoning.encrypted_content"]`; **replay every reasoning item immediately before the message it produced** (ARC-AGI-3: 13.3%→38.3% with 6× fewer output tokens from retained reasoning + compaction alone).
- `reasoning:{effort, summary:"auto"}` — Sol: `high` for architecture/debugging, `medium` daily; Luna: `low`/`medium` for subagents/summaries; never Codex's `ultra` without a rollout budget. Pin per session (changes invalidate cache).
- `text.verbosity:"low"` for the TUI/desktop, drop legacy "be brief" prompt text (5.6 over-corrects).
- `prompt_cache_key` = session id; subagents `"{parent}:{child}"`; explicit-mode breakpoint after instructions+tools; hard-cap context at **270,000** and compact there.
- `parallel_tool_calls:true`, `truncation:"auto"`, `max_output_tokens` 128k, `service_tier` as a user option.
- ChatGPT-subscription (Codex dialect): complete the measured identity — `instructions`, `text.verbosity`, `client_metadata`, `thread-id` header, echo `x-codex-turn-state` (shard locality). Later: Responses WebSocket with `generate=false` prewarm and incremental input deltas.
Tools: freeform **`apply_patch`** (Lark grammar) and PTY **`exec_command`/`write_stdin`** with `max_output_tokens≈10k` as the GPT dialect of the same kernel tools; `update_plan` (skip for easiest ~25%; no single-step plans); `get_context_remaining`; `view_image`.
Prompt (`model_instructions/gpt-5.6.md`): ≤500 tokens; permission boundary stated **once** (repeating "ask first" causes spurious approval checks); delete "be thorough"/"think deeply"; preambles every 1–3 steps; reconcile plan items to Done/Blocked; preserve `phase` metadata on assistant items.
Routing default: Terra as daily driver, Sol on demand for hard tasks, Luna for scouts/summaries/eval labour.

### 3b. Anthropic Claude Fable 5 / Opus 5

Facts: `claude-fable-5` $10/$50 (30-day retention, no ZDR), `claude-opus-5` $5/$25; 1M ctx default / 128k out; adaptive thinking (Fable: always on; Opus 5: on by default, cannot disable at xhigh/max); `output_config.effort` low…max, default high; caching min **512** tokens, 4 breakpoints, 1h TTL 2×; `context-management` (clear_thinking first, clear_tool_uses), server `compact_20260112`; `task_budget` beta; tool search + `defer_loading` (cache-transparent); `input_examples`; fine-grained tool streaming; **mid-conversation `role:"system"` messages** (Opus 5/4.8/Fable) and **mid-conversation tool add/remove** (Opus 5, beta) — both cache-preserving; `computer_toolset_20260801` / `browser_toolset_20260801`; refusal = HTTP 200 `stop_reason:"refusal"` + `fallbacks:"default"`.

Wire (Messages):
- No `thinking` param (or `{type:"adaptive"}`); `display:"summarized"` only if the UI shows reasoning; no sampling params; `max_tokens` 64k+ at xhigh/max; effort **pinned per session** — default `high`; `xhigh` for long agentic coding on Opus 5 (Claude Code's default); Fable 5 `high`, `xhigh` for the hardest; `low`/`medium` for subagents.
- Breakpoints: last tool def · end of system · end of task contract · automatic on the tail. 1h TTL when the user is interactive with gaps. Replay thinking blocks byte-for-byte.
- **Steering as `role:"system"` messages appended to `messages[]`** — Terminus's steering feature maps exactly onto this and it preserves the cached prefix (today steering is a user-role episode).
- **Progressive disclosure via `defer_loading` + `tool_addition`** on Opus 5 instead of swapping the tool array.
- `context_management`: `clear_thinking_20251015` then `clear_tool_uses_20250919` (trigger ~120k, keep 5, `clear_at_least` 20k, `exclude_tools` for `edit`/`write`); `compact_20260112` at ~150k as backstop; keep Terminus's own checkpoint as the recoverable layer. Prefer a fresh window seeded from checkpoint + progress file over repeated compaction.
- `strict:true` + `input_examples` on `edit`/`bash`; `eager_input_streaming` on `edit`/`write` once kernel streaming lands.
- `fallbacks:"default"` (beta `server-side-fallback-2026-07-01`), branch on `stop_reason` before reading content.
Prompt (`model_instructions/claude-5.md`):
- **Delete all verification/self-check instructions** (over-verification on Opus 5) — replace with verification *tools* (test runner, browser) and, on Fable 5, a fresh-context verifier subagent.
- Scope-discipline block; "Communicating with the user" block; corrections block; conciseness + deliverable-length line; `<use_parallel_tool_calls>` verbatim; no "CRITICAL: you MUST".
- Subagent damping + a deterministic spawn cap (Opus 5 over-delegates; Fable 5 delegates well — give it *when*, not *whether*).
- Fable 5: audit-claims instruction ("before reporting progress, audit each claim against a tool result"); autonomous-run reminder; "give the reason, not just the request" in the task contract; **never show a remaining-token countdown** (show steps/phase); never ask it to echo reasoning; `send_to_user` tool with an explicit instruction to use it; memory file surface; plan for minutes-long turns (async polling — Terminus's fire-and-forget turn + SSE already fits).
- De-prescribe: A/B the current prompt with step-by-step scaffolding removed.

### 3c. Open-weight models (OpenCode Zen free tier and self-hosted)

Facts: Zen live free list today: `big-pickle` (stealth, 200k/32k), `deepseek-v4-flash-free`, `muse-spark-1.2-contributor-free` (Meta; **training-data-for-access**), `mimo-v2.5-free`, `hy3-free`, `ling-3.0-flash-fin-free` (finance SKU), `nemotron-3-ultra-free`/`3.5-lightning-free` (NVIDIA-hosted, **trial only, no confidential data**), `laguna-s-2.1-free`; `kimi-k2.5-free`, `glm-5-free`, `grok-code` rotated out. Catalog from models.dev, not `/zen/v1/models` (bare ids). Rate limits unpublished; anonymous tier is a `user-agent` identity gate. Zen gateway quirks: strips/adds non-standard fields (400 on strict validators), array-content 400s, drops final text delta before tool_calls, sends `"id":null` continuation deltas, `reasoning_effort:"low"` yields more reasoning than `"max"` on some.

Per-model capability flags (new, in the provider profile — these are not optional):
- **`reasoningReplay`**: DeepSeek V4 (**400 without it**), Kimi K2.7 (error), GLM-5.x (**infinite loops** without `clear_thinking:false`), MiniMax M2.x/M3 (severe drop), Kimi K3/Qwen3.6+/LongCat (quality). Store `reasoning_content` on the episode and replay it on the assistant message.
- **`toolCallDialect`**: OpenAI-JSON; Kimi K2 (`functions.{name}:{index}` ids must be preserved verbatim — rewriting degrades the model); Kimi K3 XTML (raw unescaped string args); MiniMax `<minimax:tool_call>`; Qwen/Nemotron XML; Harmony (gpt-oss, needs `<|call|>` stop); Hy3; LongCat (`arguments` is an object, not a string). Add a tolerant text-tool-call salvager for content-embedded calls and never `JSON.parse` blindly.
- **`sampling`**: omit `temperature`/`top_p` for Kimi K3/K2.7, MiMo, DeepSeek thinking (they error or force-reset); model-specific defaults otherwise.
- **`parallelToolCalls`**, **`effortNames`** (`low|high|max` on Kimi/GLM; `chat_template_kwargs` on Nemotron with `force_nonempty_content:true`), **`maxOutput`** (32k on many free SKUs ⇒ force small single-file edits), **`workingContext`** 64–128k regardless of advertised 1M (only Nemotron 3 Ultra has a published 1M RULER score).
Harness for these: 5–6 flat tools, per-property descriptions, no nested objects; hashline edit dialect by default (the ablation gains are largest on exactly these models); one tool call per turn until `parallelToolCalls` is proven; head/tail exec; aggressive compaction at ~64k; Zen path sends string content only, strips unknown fields, tolerates `id:null` deltas, and reads cache usage on the `messages` protocol (`transport.ts:373-377`). Route the free tier to scouts, summaries, review passes and eval labour; `deepseek-v4-flash-free` and `big-pickle` are the only free ones worth trying as a primary.
Local: the `terminus.local-provider.v1` shim can drive llama.cpp/ollama/LM Studio today except for streaming (stdout decoded after exit) and `localhost` egress (`deny_private_ips:true`); add a `local-openai-compatible` connector class with loopback allowed and incremental NDJSON.

---

## 4. Token-efficiency budget (targets)

| Metric | Today (measured) | Target |
|---|---|---|
| Fixed prefix | ≈5.2k tok (3.9k developer + 1.25k tools), 1.0k cacheable | ≤3k, all cacheable |
| Repository map | 16–18k tok per attempt, unranked | 0 (grep) or ≤1k |
| Cache hit, attempt ≥2 | 0% (four independent causes) | ≥80% |
| Kernel RPCs per tool call | 12 sequential | ≤4 |
| DB transactions per tool call | 5 (+1 per 64 streamed chars) | 1 |
| Per-attempt recompute | full (16 metadata reads + AGENTS chain + map paging + 2 retrieval passes) | O(new episodes) |
| Exec result on failure | 79 B, payload deleted | full head/tail, ≤30 KiB |
| Tool result encoding | JSON-escaped | plain text |
| Steps / exec timeout | 24 / 60 s | 200 / 600 s (30 min jobs) |
| Token estimator error | −43%, never calibrated (`observeUsage` has zero call sites) | reconciled per attempt |

---

## 5. Decisions to challenge

1. **The "permanent minimal baseline" (ADR-0025/0039) has become the only profile.** `TerminusMinimalProfile` pins tools to a `z.tuple` of three literals and `subagentsEnabled/memoryEnabled/workflowEnabled` to `z.literal(false)`. Nothing can be turned on at runtime. Keep a minimal *control arm* for evals, but the shipped profile must be the full one.
2. **Fiction tax.** Either wire or delete: `packages/aci`, `prompts/`, `schemas/tools/`, `packages/memory` (keep the one-file memory), most of `packages/orchestration`, `capability-registry` (keep `mcp_relay.ts`), `workflow-compiler`, `model-router`'s learned parts, seven context-compiler modules, dead model profiles (`gpt-4o`, `claude-3-7`). Deletion is cheap and reversible in git; the cost of keeping is that every prompt, doc, ADR and future audit lies.
3. **Per-tool-call evidence ceremony** — keep for writes and external effects; free for reads.
4. **Provider neutrality that destroys native semantics.** The Context IR must carry provider-native items (reasoning items, thinking blocks with signatures, `phase` metadata, `reasoning_content`) as opaque replayable blobs per episode; today it flattens them and every family degrades silently.
5. **Verification-by-repair-turn.** For Claude 5 the vendor's own guidance is to delete verification scaffolding; make the verification coordinator a *tool the model can call* plus an independent post-hoc gate, not two automatic repair turns.
6. **SPEC-to-evidence ratio.** 9.6k-line SPEC, 0 live evals. Phase 0 item 10 is the single most important task in this document.

---

## 6. Questions for Ezzy

1. **Primary daily model** for the first live baseline — GPT-5.6 via the ChatGPT subscription (Codex dialect already works best), or Opus 5 direct? This orders Phase 3.
2. **Delete vs archive** the dead subsystems listed in §5.2 (a `legacy/` move keeps history greppable; deletion keeps the tree honest)?
3. **Benchmark target** — Terminal-Bench 4.0 via Harbor (where the vendor CLIs are), SWE-bench Pro, or internal tasks first?
4. **Computer use priority** — build the CDP browser toolset in Phase 4 as scheduled, or pull it forward ahead of subagents (it is the verification lever for UI work)?

---

## 7. Verification, evals, test health (from `08_verification_evals.md`)

- **Completion works for chat turns** at HEAD (no mutating tool ⇒ `verification_not_applicable` ⇒ COMPLETED). For a "fix this bug" task the sequence is compile → loop → harness-synthesized `completion_proposal` (the model has no submit/plan tool; it's inferred from `finishReason`) → `defaultCriteriaNodes` plan → kernel-run commands → `admitBranch` → COMPLETED — and it wrongly fails on: the **30 s** per-node timeout (F1), the **read-only macOS workspace** (F2, EPERM at repo root — every `cargo`/`bun`/`pytest`/`git` verification dies), two repair turns then FAILED_VERIFICATION with the failing statement buried in an artifact (F3), objective-keyword predicate selection that lands on unconditionally-skipped `UI_E2E` (F4), a **completion gate that hard-fails after every predicate passed** (F5), and a **kernel-restart poison pill** (F6).
- **Evals:** zero live runs ever (123 fixture rows, all `provider:"fake"`). The live path exists (`terminus-eval run --harness terminus-live …`) but records **no pass/fail and no cost** (`cli.py:391-393`), ignores `--model`, fakes the env digest, and never invokes Harbor (`cli.py:307` branches only on swe-bench). Terminal-Bench needs Docker + a registered Terminus agent plugin; SWE-bench Verified needs the `swebench` package + images.
- **Orchestration:** none reachable — EV scheduler is a pure calculator, delegation kernel always throws `SandboxUnavailableError`, `ManagedWorktreeLedger` has zero call sites, `worktreePath` is the workspace root.
- **Test health (this machine):** TS 740/0 across 8 packages (control plane 421/0 in 17.5 s), pytest 274/0, boundary-check OK, typecheck 0 errors, lint 0 errors / 2 warnings; `cargo test` 103/0/1 ignored across sandbox-macos/patch/connector/process + kernel 123/0 (all 10 integration binaries) ⇒ Rust 226/0/1 ignored across five crates; **1,613 tests green at HEAD, 0 failures** — and the prior audit's `cancel_running_process` flake did not reproduce (terminus-process 23/23). The suite being green is exactly why the findings matter: none of F1–F3, `no_runnable_checks`, or the sandbox holes has any test that would catch it; `bun test` from repo root costs ~31 s of `target/` scan (not a hang — earlier drafts corrected).
- **Working tree note:** during this audit 13 files under `apps/desktop/` were modified by a concurrent process in this checkout (substantive product edits — Priority queue, queue-while-running composer — with mtimes 00:34–00:45, and a `bun run dev` with a foreign parent PID). Not touched by this audit; all audit subagents were read-only. The only audit artifact is this folder.

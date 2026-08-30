# External research — models and SOTA harness mechanics (2026-08-29)

Subagent: claude-opus-5[1m]. All claims carry URLs in the subagent transcript; key ones reproduced.

## 1. OpenAI GPT-5.6 Sol / Terra / Luna
- Three-tier family, GA 2026-07-09. No separate `gpt-5.6-codex`; Codex runs the general tiers. `gpt-5.6` alias → Sol. (developers.openai.com/api/docs/models/gpt-5.6-{sol,terra,luna}; github.blog changelog 2026-07-09)
- Sol `gpt-5.6-sol` 1,050,000 ctx (922k max input) / 128k out / $4 in, $0.40 cached, $20 out. Terra `gpt-5.6-terra` $2/$0.20/$12. Luna `gpt-5.6-luna` $0.20/$0.02/$1.20 (after 2026-07-30 cuts). Cutoff 2026-02-16.
- **272K cliff**: prompts >272K input billed 2× input / 1.5× output for the whole request. Codex default (372k×0.95) overshoots; fix `model_auto_compact_token_limit=270000` (codex#32486).
- Reasoning effort: none/low/medium(default)/high/xhigh/max; Codex CLI adds `ultra` (subagents) — not in official API docs.
- `text.verbosity` low|medium|high; 5.6 already terser — legacy brevity prompts over-correct.
- Measured: leaner system prompts +10–15% eval, −41–66% tokens, −33–67% cost (developers.openai.com/api/docs/guides/latest-model). State permission boundaries once; repeated "ask me first" causes spurious approval checks.
- Responses features: Programmatic Tool Calling (JS in V8 isolate), hosted shell (or local via shell_call), apply_patch (V4A), tool_search, Skills, computer use, remote MCP.
- Reasoning replay: `previous_response_id`, or `include:["reasoning.encrypted_content"]` with store:false, or `reasoning.context:"all_turns"`.
- Prompt caching for 5.6: min prefix 1,024; `prompt_cache_options.ttl` default 30m; **explicit mode** `prompt_cache_options.mode="explicit"` + `prompt_cache_breakpoint` markers; writes 1.25× reads 0.1×; `prompt_cache_key` = routing affinity, not hit guarantee. Changing model/tools/schema/reasoning/verbosity invalidates.
- `service_tier: "priority"|"fast"` up to 2.5× faster at 2×; Ultrafast preview (Cerebras) limited.
- Benchmarks (secondary): Terminal-Bench 2.1 Sol 88.8 / Sol-Ultra 91.9; SWE-bench Pro Sol 64.6 / Terra 63.4 / Luna 62.7.
### Codex CLI source (openai/codex@main)
- Tool palette: `exec_command`+`write_stdin` (PTY sessions; `yield_time_ms` 250–30000 default 10000; `max_output_tokens` default 10000), `apply_patch` (**freeform Lark-grammar tool**, "do not wrap the patch in JSON"), `update_plan`, `tool_search`, `get_context_remaining`, `new_context_window`, `multi_agents(_v2)` spawn/wait/send_message/interrupt, `code_mode`, `request_permissions`, `request_user_input`, `send_user_message_async`, `view_image`, `sleep`, `wait_for_environment`, `current_time`, MCP.
- Transport: Responses **WebSocket** (`responses_websockets=2026-02-06`), lazy per turn, prewarm `generate=false`, **incremental input deltas** when request is strict extension; `store:false` + `include:["reasoning.encrypted_content"]`; `prompt_cache_key`=session id, subagents `"{source}:{parent_thread_id}"`.
- Config knobs: model_reasoning_effort, model_verbosity, model_auto_compact_token_limit, model_context_window, tool_output_token_limit, model_instructions_file, compact_prompt, web_search mode, tools.update_plan, plan_mode_reasoning_effort, review_model, approval_policy, sandbox_mode.
- Instructions (gpt-5.2-codex template; no 5.6 template public): prefer rg; apply_patch for single-file edits; skip plan tool for easiest ~25%, never single-step plans; never revert user changes; stop on unexpected changes. Prompting guide: preambles every 1–3 steps; reconcile todos; `multi_tool_use.parallel`; persist `phase` metadata (commentary/final_answer) on assistant items.

## 2. Anthropic Fable 5 / Opus 5
- Fable 5 `claude-fable-5` $10/$50, Opus 5 `claude-opus-5` $5/$25, Sonnet 5 $2/$10; 1M ctx / 128k out; adaptive thinking; default effort high. Opus 5 released 2026-07-24; Fable 5 2026-06-09.
- Effort low|medium|high|xhigh|max governs all tokens incl. tool calls; thinking cannot be disabled at xhigh/max; changing effort mid-conversation invalidates cache. At xhigh/max set max_tokens ≥64k.
- Fable 5: adaptive thinking mandatory; raw CoT never returned; `thinking.display` omitted default; refusals = HTTP 200 `stop_reason:"refusal"` with server-side `fallbacks`; 30-day retention, no ZDR.
- Thinking replay: pass `signature` back unchanged; interleaved thinking automatic, no beta header.
- Context editing beta `context-management-2025-06-27`: `clear_tool_uses_20250919` (trigger 100k, keep 3, clear_at_least, exclude_tools), `clear_thinking_20251015` listed first.
- Server compaction beta `compact-2026-01-12`: `compact_20260112` trigger ≥50k (default 150k); cache_control on system + compaction block.
- Task budgets beta `task-budgets-2026-03-13` (Opus 5/Fable 5/4.8/4.7): min 20,000; too-small budget ⇒ refusal-like early stops.
- Caching: min 512 tok on Opus 5/Fable 5; 4 breakpoints; 1h TTL 2× write; 20-block lookback.
- Tools: `computer_toolset_20260801`, `browser_toolset_20260801` (stable client toolsets), tool_search regex/bm25, memory_20250818, advisor, code_execution; per-tool `strict`, `defer_loading`, `input_examples`, `eager_input_streaming`.
- Measured (anthropic.com/engineering/advanced-tool-use): tool search −85% tool-def tokens, accuracy 49→74 / 79.5→88.1; PTC −37% tokens; `input_examples` 72→90% param accuracy; selection degrades past 30–50 tools.
- Opus 5 prompting: DELETE verification/self-check instructions (over-verification); effort doesn't shorten visible output; delegates readily — cap it; with thinking disabled, tool calls as text + leaked tags.
- Fable 5 prompting: minutes-long turns; audit-claims instruction nearly eliminated fabricated status; do NOT surface remaining-token countdown; do NOT ask it to echo reasoning (reasoning_extraction refusal); fresh-context verifier subagents > self-critique; `send_to_user` tool needs explicit instruction.
- Cross-model: `<use_parallel_tool_calls>` block → ~100% parallel rate; `<default_to_action>`; "CRITICAL: you MUST" now over-triggers on 4.5+.
- Long-running harness (anthropic.com/engineering/effective-harnesses-for-long-running-agents): initializer writes JSON feature list + progress.txt + init.sh; one feature per session; browser automation essential to stop false "done"; compaction alone failed.

## 3. OpenCode Zen free tier (models.dev provider `opencode`, 94 models, 30 free, all tool_call:true)
nemotron-3-ultra-free 1M/128k (open); longcat-2.0-free 1M; x-preview-f-free 1M; muse-spark-1.2-contributor-free 1M (**training-data-for-access**); mimo-v2-pro-free 1M/64k; kimi-k2.5-free 262k/262k (open); nemotron-3.5-lightning-free 262k; qwen3.6-plus-free 262k/65k; ring-2.6-1t-free; grok-code 256k; laguna-s-2.1-free, north-mini-code-free; glm-5-free / glm-4.7-free 204k/131k (open); minimax-m2.5-free / m2.1-free 204k/131k (open); nemotron-3-super-free (NVIDIA-hosted, **trial only, no confidential data**); deepseek-v4-flash-free 200k/128k (open); minimax-m3-free, mimo-v2.5-free, big-pickle (**stealth, limited time**) 200k/32k; hy3-free; trinity-large-preview-free (reasoning:false); ling-3.0-*, mimo-v2-flash/omni, hy3-preview, ling-2.6-flash.
Zen docs publish no rate limits/context windows. Zen is a reseller with own pricing (gpt-5.6-sol $2/$10 on Zen vs $4/$20 first-party). `/zen/v1/models` returns bare IDs — build catalog from models.dev.
Per-model tool-call format quirks / reasoning_content replay: NOT YET COVERED (pending sub-agent).

## 4. Harness mechanics 2026
- tbench.ai now Terminal-Bench 4.0; SWE-bench Pro is the live discriminator; Opus 5 launch cited Frontier-Bench, CursorBench 3.2, ARC-AGI 3, OSWorld 2.0 — not SWE-bench Verified.
- Unified persistent-PTY shell + one specialized editor is winning over grep/glob/read/edit quartets (Codex).
- Grammar-constrained freeform edit tools beat JSON diffs on OpenAI models.
- Incremental payloads over persistent WebSocket are shipped (Codex).
- Two-layer context management is table stakes (server compaction/clearing + client auto-compact + get_context_remaining + new_context_window).
- Verification tooling not verification prompting.
- Both vendors converged on: tool search/deferred loading, programmatic tool calling, first-class subagent spawn/wait/message tools.
Comparative write-ups (Amp, Factory, Cline, pi, hermes, Cursor CLI, Gemini CLI, hashline): NOT YET COVERED (pending sub-agent).

## Implications (verbatim summary from subagent)
(a) GPT-5.6: hard-cap 270k; route by tier (Sol arch/debug, Terra daily, Luna subagents); set effort explicitly (default medium); cut system prompt hard; `text.verbosity` instead of brevity prompts; explicit caching mode + breakpoint after system+tools; `prompt_cache_key` stable session id, subagents share parent shard; `store:false` + encrypted reasoning replay; freeform Lark `apply_patch`; PTY `exec_command` with ~10k output budget; `update_plan` with skip-on-easy rule; WebSocket prewarm + incremental deltas; preserve `phase` metadata.
(b) Claude 5: pin effort per session; delete verification instructions, add verification tools (browser/test runner) and fresh verifier subagent on Fable; subagent caps; no context countdown; never ask to echo reasoning; handle refusal + fallbacks; 4 breakpoints (tools/system/skills-memory/auto); context_management clear_thinking first then clear_tool_uses (~120k, keep 5) + compact at ~150k; tool_search + defer_loading past ~10 tools; `input_examples` + strict; `send_to_user`; `<use_parallel_tool_calls>`; fresh window from progress.txt over compaction.
(c) Zen/open-weight: eval + background labor, not primary loop; catalog from models.dev; 5–8 flat tools, no parallel assumption; per-model flags for reasoning replay / XML tool parse / parallel / interleaved; working budget 64–128k regardless of advertised 1M; 32k-output models need small edits; user-agent identity gate.

NOT FOUND: official GPT-5.6 prompting cookbook; `gpt-5.6-*_instructions_template.md`; primary GPT-5.6 benchmark page (403); Zen rate limits; TB-4.0 leaderboard rows.

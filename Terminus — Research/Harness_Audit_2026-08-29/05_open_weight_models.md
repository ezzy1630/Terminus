# Open-weight / cheap coding models — harness field guide (2026-08-29)

Sub-subagent research; URLs in transcript, key ones retained.

## 1. Reasoning-content replay is now the default, rules differ per vendor
| Model | Rule | Failure if wrong |
|---|---|---|
| DeepSeek V4 | With `tools`: `reasoning_content` of ALL previous turns must be passed back or API returns 400 (api-docs.deepseek.com/guides/thinking_mode) | Hard 400 |
| Kimi K2.7-Code | must keep `reasoning_content` from the assistant tool-call message "otherwise an error will be thrown"; thinking cannot be disabled | Hard error |
| Kimi K3 | add complete assistant message, not only `content` | Silent degradation |
| Kimi K2.6 | opt-in `{"thinking":{"type":"enabled","keep":"all"}}`; K2.5 no preserved thinking | CoT loss |
| GLM-5.x | agentic: pass `reasoning_content` back, `clear_thinking:false` | Infinite loops (goose#7363: 40 tool calls for 2-min task, corrupts files) |
| MiniMax M2.x/M3 | append complete response; with `reasoning_split=False` do not modify `content` | Severe quality drop |
| Qwen3.6/3.8 | `preserve_thinking` default true | — |
| gpt-oss (Harmony) | replay CoT within a turn across tool calls; drop after `final` | — |
| LongCat-2.0 | `save_reasoning_content=True` | quality |
| Nemotron 3 | NOT FOUND | — |

## 2. Model matrix (Aug 2026)
Kimi K3 2.8T/104B 1M ctx, Kimi K3 License, $3→$15 cache 0.30 · Kimi K2.7-Code 1T/32B 262k/32k Modified MIT $0.95→$4 · Kimi K2.6 · GLM-5.3 753B 1M/128k (GLM-5.3 license, dropped MIT) · GLM-5.3-Flash 321B MIT ~$0.10 · GLM-5.2 MIT $1.40→$4.40 · DeepSeek V4-Pro-0813 1.7T/49B 1M/384k MIT $0.66→$1.98 off-peak, cache-hit $0.022 · DeepSeek V4-Flash-0731 304B $0.22→$0.66 · MiniMax-M3 428B/23B 1M $0.30→$1.20 · MiniMax-M2.7 230B/10B 196k · Qwen3-Coder-Next 80B/3B 262k Apache-2.0 · Qwen3.8-Flash-Next 125B/6B · gpt-oss-120b 131k Apache-2.0 (no 2026 successor found) · Nemotron 3 Ultra 550B/55B 1M OpenMDW ~$0.50 · Nemotron 3.5 Lightning 30B/3B · Devstral 2 123B retired 2026-07-31 → Mistral Small 4 · Hy3 295B/21B Apache-2.0 · MiMo-V2.5-Pro 1.02T/42B MIT · LongCat-2.0 1.6T/48B MIT $0.75→$2.95 · Ling-3.0-flash · Ring-2.6-1T · Laguna S 2.1 (Poolside) 118B/8B free on Zen. DeepSeek R2: NOT FOUND.

## 3. Tool-call wire formats + serving flags
- Kimi K2.x: `<|tool_calls_section_begin|>`; ids MUST be `functions.{name}:{index}` monotonically increasing across the conversation — rewriting to `call_abc` degrades the model (sglang#10600). vLLM `--tool-call-parser kimi_k2`.
- Kimi K3: new "XTML" channel format `<|open|>tools<|sep|><|open|>call tool="x" index="1"…`; string args are raw unescaped text. `--tool-call-parser kimi_k3`; prefix caching off by default.
- GLM-5.3: `--tool-call-parser glm47 --reasoning-parser glm45`.
- MiniMax M2.7/M3: `<minimax:tool_call><invoke name="f"><parameter name="p">v</parameter></invoke>`; corrupted on stable vLLM, nightly required.
- Qwen3-Coder-Next / Nemotron 3: XML-ish `qwen3_coder`; Nemotron `nemotron_v3` + `force_nonempty_content:true` or coding agents choke.
- gpt-oss: Harmony channels only; stop tokens must include `<|call|>`; leaks `<|channel|>commentary` into tool names (vllm#32587).
- Hy3: `<tool_calls><tool_call><arg_key>/<arg_value>`; XML leaks into reasoning ⇒ JSON parse errors (opencode#25644).
- LongCat-2.0: `arguments` is a dict not a JSON string — breaks every `JSON.parse` client.
- Live parser bugs: vLLM kimi_k2 never json.loads (malformed args with 200); SGLang K2.5 fails past ~3 rounds; K2.6 wrong calls from round 2; SGLang MiMo drops all text after last tool call.

## 4. Sampling / effort
Kimi K3/K2.7: temperature=1.0, top_p=0.95 FIXED — any other value errors; omit. MiMo thinking: forcibly reset. DeepSeek thinking: temperature/top_p unsupported. Others: GLM 1.0/0.95; MiniMax 1.0/0.95/top_k 40; Qwen3-Coder-Next 1.0/0.95/40; gpt-oss 1.0/1.0; Nemotron 1.0/0.95; Hy3 0.9/1.0; Ling 0.6/0.95; Devstral 0.15.
Effort: Kimi K3 low|high|max (dflt max); GLM-5.3 low|high|max; DeepSeek medium→high; Nemotron `chat_template_kwargs:{enable_thinking,reasoning_budget}`; Hy3 `reasoning_effort` + `interleaved_thinking:true`.

## 5. Leaderboards
AA open-weights: Kimi K3 60 · GLM-5.3 60 · Qwen3.8-2.4T 58 · GLM-5.3-Flash 57 · DeepSeek V4 Pro 53 · MiniMax-M3 45 · Nemotron 3 Ultra 38.
TB-2.1 (mixed harnesses): Kimi K3 88.3 · GLM-5.3 88.2 · DeepSeek V4 Pro 87.9 · GLM-5.3-Flash 84.3 · Hy3 71.7 · LongCat 70.8 · Laguna 70.2 · MiniMax M3 66.0 · Nemotron 3 Ultra 56.4 · Nemotron 3.5 Lightning 24.6. TB-3.0: GLM-5.3 28.3 best open.
SWE-bench Verified: DeepSeek V4-Pro-Max 80.6 · MiniMax M3 80.5 · Kimi K2.6 80.2 · MiMo-V2.5-Pro 78.9 · Hy3 78.0 · Nemotron 3 Ultra 70.7 · Qwen3-Coder-Next 70.6 · gpt-oss-120b 62.4.
Long context: Nemotron 3 Ultra RULER@1M 95% is the only published 1M number; AA-LCR Kimi K3 82.7, K2.5 70.0, Nemotron 3.5 Lightning 49.2. GLM/DeepSeek/MiniMax/Kimi 1M claims vendor-asserted only.
Endpoint quality varies wildly: AA Endpoint Accuracy Index — gpt-oss-120b endpoints 22% vs 37% reference on BFCL purely from parsing; GLM-5.2 endpoints half reference from output caps.

## 6. OpenCode Zen live (fetched 2026-08-29, unauthenticated, 64 ids)
Free now: big-pickle, deepseek-v4-flash-free, muse-spark-1.2-contributor-free, mimo-v2.5-free, hy3-free, ling-3.0-flash-fin-free (finance SKU, not coding), nemotron-3-ultra-free, nemotron-3.5-lightning-free, laguna-s-2.1-free. Rotated OUT: north-mini-code, trinity, x-preview-f, longcat-2.0, ring-2.6-1t, glm-5-free, kimi-k2.5-free, grok-code.
Identities: big-pickle = stealth, 200k/32k, 50.8% SWE Atlas, DeepSeek-looking infra. muse-spark-1.2 = Meta, data-for-price. laguna = Poolside. Rate limits unpublished (community ~100/day).
Zen breakage: non-standard `mcp`/`system` top-level fields ⇒ 400 on strict validators (kimi/glm/hy3) (#37771); array-format assistant content ⇒ 400 on all Zen models (#41766); streaming drops final text delta before tool_calls (#40959); continuation deltas send `"id":null` (#43328); muse-spark only on /responses, stalls text→tool→text (#44659); laguna leaks `<think>` (#43770); advertised context wrong (laguna 256k not 1M) (#40892); `reasoning_effort:"low"` yields MORE reasoning than "max" (#40777).
Z.ai has a real Anthropic surface `https://api.z.ai/api/anthropic`; DeepSeek V4 advertises Anthropic-compatible format.

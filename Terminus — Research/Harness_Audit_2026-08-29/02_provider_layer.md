# Terminus provider-layer audit — HEAD c2cd9d5 (2026-08-29)

Subagent: claude-opus-5[1m]. Items marked ✔ were re-verified by the lead at the cited lines.

## A. Feature matrix

| Capability | OpenAI Responses (direct) | Codex dialect (ChatGPT sub) | Anthropic Messages | Zen gateway | Local command |
|---|---|---|---|---|---|
| Streams to client | N ✔ — kernel buffers whole body for any credentialed grant (`crates/terminus-kernel/src/services.rs:3094-3105`); TS believes it streams (`direct-provider-transport.ts:124-126`) | N | N | N (anonymous Zen only: Y) | N — stdout decoded after exit (`provider-command.ts:258-270`) |
| Cancel reaches provider | N — JoinHandle dropped never aborted (`mini-services/terminus-kernel/src/grpc.rs:1633`) | N | N | N | P — `jobs.Stop` (`provider-command.ts:277-281`) |
| Retry (3 attempts) | Y `index.ts:16063-16086`, `provider-retry.ts:209-238` | Y | Y | Y | Y |
| Retry-After honored | N — every throw passes only `{status}` (`direct-provider-transport.ts:142,177,272,282`; `gateway-kernel-client.ts:212`) | N | N | N | P (`provider-command.ts:60`) |
| Cache hints | P — `prompt_cache_key`=epoch id (`openai-runtime.ts:67-72`, `index.ts:15411`); `cache_control` stripped (`provider-openai/src/index.ts:531-547`) | Y — thread id (`chatgpt_codex.ts:139-141`, `index.ts:14776`) | P — ONE `cache_control` on a system block (`provider-anthropic/src/index.ts:220-224`); none on tools (`:323-329`) or messages | N — no cache key (`provider-zen/src/renderer.ts:118-151`) | N |
| Reasoning replay (encrypted items) | N — no reasoning item type (`provider-openai/src/index.ts:87-95,558-594`) | N — requests `include:["reasoning.encrypted_content"]` (`chatgpt_codex.ts:138`) then discards it (`stream.ts:143-156`) | n/a (no thinking replay either) | N | N |
| Reasoning effort on wire | N in practice ✔ — gated on `reasoningReserveTokens > 0n` (`provider-openai/src/index.ts:177-179`); reserve hardcoded `0n` (`index.ts:11348`) | Y — clamped to catalog (`chatgpt_codex.ts:142-150`) | N ✔ — `thinking` gated on same reserve; emits `budget_tokens` + `temperature 0.2` (`provider-anthropic/src/index.ts:95-106`) — both 400 on Fable 5/Opus 5 | N (`renderer.ts:57-60`) | N |
| max/xhigh fidelity | N — `max→high` (`provider-openai/src/index.ts:124`) | Y (`chatgpt_codex.ts:79,95-101`) | N | N | n/a |
| `text.verbosity` | N (zero occurrences repo-wide) | N | n/a | N | N |
| Tool `strict` | Y (`provider-openai/src/index.ts:402-434,447`) | Y withdrawn like Codex CLI (`chatgpt_codex.ts:160-162`) | n/a | P | N |
| `parallel_tool_calls` | N | Y (`chatgpt_codex.ts:164`) | N | N | N |
| Usage incl. cached | Y `stream.ts:282-295` | Y | Y `provider-anthropic/src/stream.ts:106-107,219-220` | P — chat/responses Y (`provider-zen/src/transport.ts:469-483`); `messages` protocol drops cache fields (`:373-377`) | Y |
| Cost | Y models.dev (`direct-provider-config.ts:110-112`) | N — prices forced 0 (`provider-account-models.ts:293-295`) | Y | Y (`provider-zen/src/catalog.ts:220-222`) | economics 0n (`index.ts:11117-11121`) |
| `instructions` field | N — system → `developer` items (`provider-openai/src/index.ts:345-360`) | N — diverges from measured Codex contract | n/a | N | N |
| `store` | omitted ⇒ true; false only under ZDR (`provider-openai/src/index.ts:180-182`) | forced false (`chatgpt_codex.ts:134`) | n/a | inherited | n/a |
| Beta headers | N — `OpenAI-Beta` rejected by connector allowlist (`connectors.rs:104-113`, `broker.rs:714,739-748`) | N | N — `anthropic-beta` rejected; only `anthropic-version: 2023-06-01` (`anthropic-runtime.ts:31`) | N | n/a |
| Claude 4.x/5 features (adaptive thinking, effort, context_management, tool_search, memory, 1h TTL, 1M) | — | — | N, all — blocked by header ban | — | — |

Model profiles: `provider-openai/src/model_profiles.ts` (gpt-4o, o3-mini) and `provider-anthropic/src/model_profiles.ts` (`modelFamilyRef:"claude-3"`) are dead at runtime. Live capabilities from Codex catalog (`provider-account-models.ts:254-309`), models.dev fetch, or offline snapshot (`provider-core/src/catalog/models_dev_snapshot.json` — only gpt-4o/o1/o3-mini, claude-3-5-*). No GPT-5.x or Claude 4/5 id in any non-test source. UI model choice IS honored (`index.ts:6208-6210 → 3827-3829 → 14709,14747,14776`); prior live-run symptom = transport precedence (account > env > gateway > local, `:14699-14701`) + direct-Anthropic discarding effort (`direct-provider-transport.ts:542-544`).

Budget ✔ `index.ts:11341-11352`: `output=1024n`, `reasoning=0n`, `toolResult=512n`, `recovery=256n`; `testedSafeTokens = Math.min(contextTokens, 32_768)` in `provider-account-models.ts:517`, `direct-provider-config.ts:148`, `gateway-provider-config.ts:195`.

Local protocol `terminus.local-provider.v1` (`provider-command.ts:27-68`) could drive llama.cpp/ollama/LM Studio via a shim; missing incremental streaming, strict, reasoning_content, cache fields; `localhost` not in egress allowlist + `deny_private_ips:true` (`connectors.rs:200-219`).

## B. Root cause: cachedInputTokens = 0 (four independent mechanisms)
1. Cacheable prefix capped ~1.6–2.5k tokens; optional fragments re-sorted by utility per attempt (`context-compiler/src/index.ts:1288,1349-1352`); on Anthropic prefix can fall below `minimumTokens: 2_048` (`provider-account-models.ts:533`).
2. Zen `messages` decoder discards cache usage (`provider-zen/src/transport.ts:373-377`).
3. Anthropic single breakpoint in wrong index space: `planCacheEpoch` returns fragment index (`context-compiler/src/index.ts:1452`) tested against system-block counter (`provider-anthropic/src/index.ts:222`); no breakpoint on tools/messages.
4. No cache key on gateway path.
Cleared: system prompt static; manifestId not in prompt; tool order deterministic. `cache-debug.ts` dead (`previousCacheEpoch` never supplied `index.ts:15259-15293`); `CacheRatioMonitor` live (`:15715,16143-16144`) observation only.

## C. Ranked findings
1. No provider call streams (`services.rs:3094-3105`). Fix: incremental redaction with carry buffer.
2. Cancel never reaches provider (`grpc.rs:1633`). Fix: hold JoinHandle, abort on drop, CancellationToken into dispatch.
3. Reasoning effort/thinking dead except Codex (`index.ts:11348`). Fix: derive from effort option, not reserve.
4. Output capped 1024 (`index.ts:11347`). Fix: model record `outputTokens`.
5. Context clamped 32,768 everywhere. Fix: per-family ceilings.
6. Reasoning items never replayed (Codex/OpenAI). Fix: `reasoning` input item + capture `encrypted_content`.
7. `anthropic-beta`/`OpenAI-Beta` rejected by kernel allowlist (`broker.rs:714,739-748`).
8. Zen messages decoder drops cache usage.
9. Retry-After discarded at five throw sites.
10. Retry replays already-emitted text (`index.ts:16063-16087`).
11. Anthropic breakpoint index-space bug; need 4 breakpoints.
12. `store` defaults true on direct OpenAI.
13. All ConnectorError variants flatten to PermissionDenied (`services.rs:3056-3063`).
14. Offline model snapshot two generations stale.
15. `fetchModelsDevRaw` uses raw `globalThis.fetch` (`provider-models.ts:250-268`).
16. Codex identity incomplete: no `instructions`, `text.verbosity`, `client_metadata`, `thread-id` (`connectors.rs:66-74`); `x-codex-turn-state` never echoed (`index.ts:12858-12871`).
17. Redirects unbounded (`broker.rs:921-928`) UNVERIFIED.
18. New `reqwest::Client` per dispatch (`broker.rs:921`) — TLS handshake every call.

## D. Model-specific needs
GPT-5.x: replay reasoning items; `instructions` not developer items; `reasoning:{effort,summary}` unconditional, keep xhigh/max; `text.verbosity`; `prompt_cache_key` on every OpenAI-shaped path; `parallel_tool_calls`, `truncation:"auto"`, `service_tier`; `store:false`; raise max_output_tokens and context clamp.
Claude 5: admit `anthropic-beta`; 4 breakpoints; adaptive thinking (`thinking:{type:"adaptive"}` — NOT budget_tokens) + `output_config.effort`; drop temperature; replay thinking blocks; 1M context default + 1h TTL; server-side compaction beta; fine-grained tool streaming; tool_search/memory.
Cross-cutting: streaming + cancellation gate everything.

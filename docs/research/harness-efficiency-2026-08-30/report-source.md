# Harness efficiency research and Terminus upgrade

**Audience:** Terminus maintainers

**Date:** 2026-08-30

**Scope:** Coding-agent inference cost, token use, cache reuse, latency, tool-output growth, compaction, routing, and concurrency.

**Acceptance surface:** The committed Terminus checkout on branch `codex/harness-efficiency-20260830`, plus deterministic request-shape and repository validation.
**Out of scope:** Paid live-provider calls, changing model defaults without an eval, enabling semantic memory, production deployment, and claims that Terminus is globally optimal without comparative workload evidence.

## Executive answer

The right objective is not "fewest tokens." It is the lowest expected cost and wall time for a verified successful task. Token count alone is unsafe because rewriting a conversation can destroy a cheap cached prefix, trigger a costly prefill, omit evidence, or cause recovery turns. The most useful operating metric is:

```text
quality-adjusted cost
  = (uncached input cost + cache-write cost + cache-read cost
     + output/reasoning cost + tool/runtime cost)
    / verified task success
```

Terminus already contains most of the architecture found in strong current harnesses: deterministic stable-prefix ordering, compiler-owned cache plans, provider-native usage accounting, bounded tool output with artifact continuation, progressive tool activation, structured compaction with exact recall, adaptive context budgets, and an evidence gate.

The concrete high-leverage defect was at the OpenAI Responses wire boundary. The compiler chose cache breakpoints, but the renderer discarded them. GPT-5.6 therefore ran in implicit mode, could cache a changing suffix, and used an over-limit fallback affinity key. This branch fixes that path:

- GPT-5.6 Responses requests use `prompt_cache_options.mode = "explicit"`.
- The last cacheable compiler-selected message or tool result carries `prompt_cache_breakpoint`.
- Volatile content after that boundary remains unmarked.
- The supported `30m` TTL is declared from provider capabilities.
- Stable affinity keys are forwarded through the live native executor and normalized to at most 64 characters without exposing an oversized human-readable scope.
- Responses usage now preserves `cache_write_tokens`; exact cost and runtime budget reconciliation apply GPT-5.6's 1.25x cache-write rate.
- Older OpenAI model families and Chat Completions keep automatic-prefix behavior because the new fields are model and protocol specific.

This is a request-shape and capability correction, not proof of a live cache hit. Local tests prove the exact JSON boundary. A paid GPT-5.6 conformance run is still needed to measure `cached_tokens`, `cache_write_tokens`, TTFT, cost, and task success across repeated turns.

## Method

The research used three evidence classes:

1. Current provider documentation for cache semantics, token accounting, reasoning effort, and context management.
2. Commit-pinned source inspection of Codex, OpenCode, Pi, Hermes, and Grok Build.
3. Primary research on coding-agent observation compression and inference serving.

Repository claims were checked against the isolated Terminus worktree. Third-party benchmark results are reported as findings from their stated workloads, not as expected Terminus gains.

## What the strongest current systems converge on

### 1. Preserve the prefix before trying to shrink the transcript

OpenAI now gives GPT-5.6 and later explicit cache controls: `prompt_cache_options.mode` selects implicit or explicit behavior, while `prompt_cache_breakpoint` marks the chosen boundary. The official examples place dynamic developer and user content after the marked stable input. The same documentation shows that a tool result can carry a breakpoint and warns that minimum cacheable length varies by model. [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)

Anthropic documents the same structural rule in a different dialect: order tools, system content, and messages consistently, then put `cache_control` on the last shared block. Its documentation explicitly warns that placing the breakpoint on a timestamp or other changing block can pay for a fresh write on every request without producing a hit. [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

Gemini implicit caching also rewards common large content at the beginning and similar requests close together. Its minimum input threshold is model dependent. [Gemini context caching](https://ai.google.dev/gemini-api/docs/caching)

The provider-neutral rule is therefore:

```text
tools and authority -> stable project rules -> stable task state -> volatile observation -> current request
```

Exact bytes and ordering matter. An affinity key helps route similar prefixes, but it does not make different content reusable.

### 2. Optimize observations before they enter durable history

Tool output is the fastest-growing part of a coding-agent transcript. OpenCode stores full over-limit output on disk and gives the model a bounded preview plus an explicit continuation hint. Its defaults are 2,000 lines or 50 KiB. [OpenCode bounded output source](https://github.com/anomalyco/opencode/blob/10765ff2a9da8c3b88e4de873aa383a49c318912/packages/opencode/src/tool/truncate.ts#L12-L150)

The CoACT paper frames observation compression as a constrained problem: reduce total tokens while keeping task effectiveness close to the uncompressed agent. On its SWE-bench Verified experiments across three agentic models, it reports a 33.0% average reduction in total token consumption with close task effectiveness. More important than the headline is the mechanism: compress a new observation before appending it, so the historical prefix stays unchanged. The paper also shows why token count alone misleads: two trajectory compressors reduced tokens substantially, but one increased estimated total cost after cache reuse fell. [CoACT paper](https://arxiv.org/html/2607.02911v1)

Paritok-4B makes a related case for typed, intent-conditioned, mostly extractive compression of coding-agent segments. It reports 25.7% retained context size and 86.5% of uncompressed single-shot solve quality on its 300-instance SWE-bench Lite setup. The authors explicitly state that this is not an end-to-end agent-cost result, and that using GPT-5 itself as the compressor was net-negative under their list-price analysis. [Paritok-4B paper](https://arxiv.org/html/2608.24188)

Terminus already follows the safer half of this pattern: bounded model-visible results, immutable artifact references, explicit continuation, and exact recall. Learned observation compression should remain gated until a paired cohort proves savings without evidence or completion loss.

### 3. Compact with structural integrity and cache economics

Compaction is necessary for long tasks, but rewriting old history invalidates the prefix from the first changed token.

- Codex trims function-call history to fit its remote compaction request and retains normal tool visibility and parallel-tool settings. It sends the current reasoning effort and service tier, so the inspected path does not prove a cheaper summarizer route. [Codex compaction source](https://github.com/openai/codex/blob/94cbbddafc1776d5e377bca1b05932c697e82238/codex-rs/core/src/compact_remote_request.rs#L23-L97)
- OpenCode preserves a configurable recent tail and only prunes older completed tool results when enough content can be reclaimed. [OpenCode compaction source](https://github.com/anomalyco/opencode/blob/10765ff2a9da8c3b88e4de873aa383a49c318912/packages/opencode/src/session/compaction.ts#L223-L316)
- Pi uses provider-reported usage for the last settled request, estimates only later messages, avoids cutting at a tool-result boundary, and disables cache retention for one-off summary calls. [Pi compaction source](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/core/compaction/compaction.ts#L198-L238) [Pi summary dispatch](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/core/compaction/compaction.ts#L572-L599)
- Hermes declares its stable boundary rather than inferring it from delimiters. Its micro-compaction remains opt-in because every history rewrite can break the prompt-cache prefix. [Hermes cache boundary](https://github.com/NousResearch/hermes-agent/blob/4f22543509d1b91dc45bcb369447126c5eb14fb7/agent/prompt_cache_boundary.py#L1-L89) [Hermes micro-compaction note](https://github.com/NousResearch/hermes-agent/blob/4f22543509d1b91dc45bcb369447126c5eb14fb7/docs/micro-compaction.md#L1-L166)
- Grok Build precomputes a compaction pass under a prefix fingerprint and model ID, permits one producer, rejects stale results, and suppresses repeated deterministic, credit, or authentication failures. [Grok Build compaction source](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-shell/src/session/compaction_config.rs#L12-L177)

The common safe design is: preserve call/result pairs, retain a recent tail, fingerprint the exact source, single-flight expensive work, make failures explicit, and measure cache loss before making compaction more aggressive.

### 4. Control model work, not just prompt size

OpenAI documents `reasoning.effort` as a direct speed, token, and quality tradeoff. Lower effort generally favors lower latency and token use, while higher effort is intended for harder work. The default and supported ladder are model specific. [OpenAI reasoning guide](https://developers.openai.com/api/docs/guides/reasoning)

This should be a stage-level decision, not a universal low setting. Cheap retrieval, classification, summarization, and verification preparation can use a smaller model or lower effort only after a cohort proves task-level non-inferiority. Hard debugging and final verification often justify higher effort because one correct turn can be cheaper than several weak recovery turns.

Linking Responses calls with `previous_response_id` is not itself a token-cost optimization. OpenAI states that earlier input in the response chain is still billed. [OpenAI conversation state](https://developers.openai.com/api/docs/guides/conversation-state)

### 5. Keep tool schemas and execution demand-driven

Large tool palettes consume tokens on every request and increase selection ambiguity. Terminus already has progressive activation and a minimal/adaptive tool profile. That is aligned with strong harness behavior, but further pruning needs ACI and completion evidence because hiding the one needed tool creates extra turns or failure.

Parallel execution helps only for independent work. Codex uses a capability decision and a read/write lock so parallel-safe calls can overlap while unsafe calls serialize. [Codex parallel tool source](https://github.com/openai/codex/blob/94cbbddafc1776d5e377bca1b05932c697e82238/codex-rs/core/src/tools/parallel.rs#L115-L178)

### 6. For self-hosted inference, routing is part of caching

vLLM automatic prefix caching reuses the KV cache of requests with the same prefix, skipping shared-prefix computation. Its production routing documentation also describes the tradeoff between prefix affinity and live load: sending every warm-prefix request to one busy worker can be worse than accepting a miss on an idle worker. [vLLM automatic prefix caching](https://docs.vllm.ai/en/v0.22.1/features/automatic_prefix_caching/) [vLLM prefix-aware routing](https://docs.vllm.ai/projects/production-stack/en/latest/use_cases/prefix-aware-routing.html) [vLLM load-aware routing](https://docs.vllm.ai/projects/production-stack/en/latest/use_cases/loadaware-routing.html)

SGLang's RadixAttention is a broader serving design for reusing KV cache across structured programs. Its paper reports up to 6.4x throughput on the authors' evaluated workloads and baselines. This is workload-specific research evidence, not a Terminus projection. [SGLang paper](https://arxiv.org/abs/2312.07104)

## Terminus gap matrix

| Area | Present in the repository | Gap or risk | Decision |
|---|---|---|---|
| Stable prefix | Compiler ordering, content hashes, cache epochs, provider plans | OpenAI Responses discarded the selected boundary | Fixed on this branch |
| Cache accounting | Predicted and actual read/write telemetry; exact read, write, input, output, and reasoning cost components | No paid repeated-turn GPT-5.6 conformance evidence yet | Measure before claiming savings |
| Tool output | Bounded previews, artifacts, continuation, exact recall | Learned observation compression is not proven on Terminus cohorts | Defer behind paired eval |
| Tool schemas | Progressive activation and minimal/adaptive profiles | More pruning may hide necessary tools | Defer behind ACI and completion eval |
| Compaction | Structured claims, call/result integrity, recent tail, recall | Rewriting can lose prefix reuse; generic semantic compaction is disabled live | Keep disabled until long-horizon cost-quality evidence |
| Routing | Economics, predicted cache reads, posterior reliability | Cache observations are not yet a durable cohort-separated learning signal | Defer adaptive changes behind promotion gate |
| Delegation | Single-agent default, EV model, token/loop caps | Parallel agents can duplicate reads and create merge overhead | Keep opt-in and separability-gated |
| Memory | Deterministic working memory; durable semantic memory off | Stale or contradictory memory can increase retries and harm | Keep off until provenance and held-out utility gates pass |

## Implemented change

### Provider contract and request rendering

`packages/provider-openai/src/index.ts` now:

- defines the current Responses cache option and breakpoint content shapes;
- enables explicit caching only when provider capabilities request explicit breakpoints and the model resolves to GPT-5.6;
- preserves compiler fragment-index breakpoints while translating canonical fragments into Responses items;
- marks supported message or `function_call_output` content;
- leaves later volatile items untouched;
- normalizes `sha256:<hex>` to its 64-character payload and hashes other oversized affinity keys;
- keeps older model requests free of GPT-5.6-only fields.

### Capability truth and live wiring

`mini-services/terminus-control/src/direct-provider-config.ts` advertises explicit breakpoints only for GPT-5.6 over the Responses protocol. The OpenAI GPT-5.6 rendering profiles now agree with that runtime capability.

`mini-services/terminus-control/src/providers/native-direct-executor.ts` forwards the stable context-epoch key that the control loop already supplied. `openai-runtime.ts` normalizes the key before a late body override, so the live path cannot bypass the renderer's bound.

`packages/provider-openai/src/stream.ts` decodes GPT-5.6's `cache_write_tokens`. Provider economics now represents a cache-write rate separately, and the direct GPT-5.6 capability snapshot declares the documented 1.25x input rate. Actual native spend and budget reconciliation include that component instead of treating writes as ordinary input.

The compiler separately carries the estimated full input and the complete prefix through the latest selected breakpoint, including tool schemas. Pre-dispatch admission prices that span as a cold write when the provider declares a write rate. Automatic-cache input is priced as an ordinary cold miss because cache warmth is not guaranteed. Observed reads and writes replace the conservative bound after settlement without corrupting read-hit telemetry.

### Before and after

```text
Before
  prompt_cache_key: "sha256:<64 hex>"  # 71 characters
  no prompt_cache_options
  no compiler-selected Responses breakpoint
  changing suffix eligible for an implicit write

After for GPT-5.6 Responses
  prompt_cache_key: "<64 hex>"
  prompt_cache_options: { mode: "explicit", ttl: "30m" }
  stable content: prompt_cache_breakpoint = { mode: "explicit" }
  changing suffix: no breakpoint
```

## Verification evidence

Observed locally in the isolated worktree:

- All 47 focused compiler, provider, economics, profile, direct-configuration, and native-runtime tests passed with 224 assertions.
- The OpenAI provider conformance test passed in the broader provider test run.
- Package TypeScript checking passed.
- All 772 package unit tests passed with 5,679 assertions.
- The first-party standalone dependency check passed.
- Repository ESLint completed with zero errors and two pre-existing warnings in generated kernel client files.
- `git diff --check` passed.

The test suite includes explicit assertions for:

- stable-task breakpoint placement;
- tool-result breakpoint placement;
- volatile-suffix exclusion;
- legacy model omission of explicit options;
- deterministic bounded fallback and caller affinity keys;
- live-executor cache-key forwarding;
- GPT-5.6 capability/profile agreement.
- cache-write usage decoding, provider-specific write pricing, and runtime budget reconciliation.
- full latest-breakpoint span propagation, explicit cold-write admission, and automatic-cache cold-miss admission.

The complete repository gate is reported separately in the branch handoff. A clean worktree initially lacked Prisma output; after local client generation, `typecheck:scripts` reached one unrelated existing error in `mini-services/terminus-control/src/permission-profiles.ts:110` (`TS2366`). This branch does not modify that file. `just codegen` refreshed the generated inventory, but the final `just codegen-check` retry was blocked at its second `buf generate proto` by the external BSR `resource_exhausted: too many requests` rate limit.

## Recommended next experiments

These are ordered by evidence value, not by implementation novelty.

1. **Paid repeated-prefix conformance.** Run the same GPT-5.6 stable prefix twice with distinct volatile suffixes. Record cache writes and reads, uncached input, TTFT, total cost, and exact request hashes. A successful API response alone is insufficient.
2. **Cache-aware compaction cohort.** Compare no compaction, existing structured compaction, and observation-first compression. Gate on verified task success, evidence coverage, cached/uncached cost, recovery turns, and latency.
3. **Cache-protection feedback.** Convert sustained predicted-versus-actual cache misses into a bounded diagnostic and next-attempt protection signal. Do not let one miss silently rewrite routing or context policy.
4. **Action-preserving observation compression.** Start with deterministic extractive projections by tool kind. Consider a learned compressor only after exact-span retention, poisoned-output, and SWE-style completion cohorts pass.
5. **Stage-specific effort routing.** Evaluate low/medium/high effort by stage. Promote only a Pareto improvement in verified success, cost, and wall time.
6. **Self-hosted prefix/load routing.** If Terminus adds a multi-worker local serving plane, route with both prefix affinity and queue load. A cache-only scheduler can create a hot worker.

## Limits

- No live OpenAI request was sent. No cache-hit or dollar-savings claim is verified for this branch.
- Provider caching interfaces and prices are time-sensitive. Recheck official documentation before release.
- Open-source source inspection describes the cited commits, not every released build or hosted service.
- Paper results use their own agents, models, benchmarks, and cost assumptions. They justify experiments, not default changes.
- "Most efficient harness" is not a defensible release claim without a public, reproducible, quality-adjusted benchmark across representative workloads.

## Claim-to-source ledger

| Source | Version or retrieval | Claims used |
|---|---|---|
| [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) | Retrieved 2026-08-30 | Explicit/implicit controls, breakpoint shapes, TTL, varying-suffix layout |
| [OpenAI conversation state](https://developers.openai.com/api/docs/guides/conversation-state) | Retrieved 2026-08-30 | Prior chain input remains billed with `previous_response_id` |
| [OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning) | Retrieved 2026-08-30 | Model-specific effort ladder and speed/token/quality tradeoff |
| [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) | Retrieved 2026-08-30 | Ordered exact-prefix caching, TTL, breakpoint invalidation |
| [Anthropic token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting) | Retrieved 2026-08-30 | Free, separately rate-limited token preflight |
| [Anthropic context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing) | Retrieved 2026-08-30 | Beta removal of old tool results and thinking blocks |
| [Gemini caching](https://ai.google.dev/gemini-api/docs/caching) | Updated 2026-08-13 UTC | Implicit-cache eligibility and stable-prefix guidance |
| [vLLM APC](https://docs.vllm.ai/en/v0.22.1/features/automatic_prefix_caching/) | v0.22.1 docs | Shared-prefix KV reuse |
| [SGLang](https://arxiv.org/abs/2312.07104) | arXiv:2312.07104 | RadixAttention and workload-specific throughput result |
| [Codex](https://github.com/openai/codex/blob/94cbbddafc1776d5e377bca1b05932c697e82238/codex-rs/core/src/compact_remote_request.rs#L23-L97) | commit `94cbbdda` | Remote compaction request behavior |
| [OpenCode](https://github.com/anomalyco/opencode/blob/10765ff2a9da8c3b88e4de873aa383a49c318912/packages/opencode/src/session/compaction.ts#L223-L316) | commit `10765ff2` | Recent-tail retention and tool-result pruning |
| [Pi](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/core/compaction/compaction.ts#L198-L238) | commit `853a80d2` | Usage-aware compaction threshold and pair-safe cuts |
| [Hermes](https://github.com/NousResearch/hermes-agent/blob/4f22543509d1b91dc45bcb369447126c5eb14fb7/agent/prompt_cache_boundary.py#L1-L89) | commit `4f225435` | Declared stable prefix boundary |
| [Grok Build](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-shell/src/session/compaction_config.rs#L12-L177) | commit `bc7f02ed` | Single-flight prefire compaction and failure suppression |
| [CoACT](https://arxiv.org/html/2607.02911v1) | arXiv v1, 2026 | Action-preserving observation compression and cache-aware cost findings |
| [Paritok-4B](https://arxiv.org/html/2608.24188) | arXiv v1, 2026-08-25 | Typed extractive coding-context compression and economics caveat |

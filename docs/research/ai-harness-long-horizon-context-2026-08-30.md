# Long-horizon agent context: compaction, memory, and recovery

**Research cutoff:** 2026-08-30
**Audience:** Terminus maintainers
**Scope:** OpenAI Codex, OpenCode, Pi, Grok Build, Hermes Agent, Gemini CLI, Aider, SWE-agent, OpenHands, and the current Terminus implementation.

## Direct answer

No inspected harness has a lossless summarizer, and there is no public, controlled benchmark that establishes one product as the best long-horizon system. The strongest defensible design is a composition of four different records:

1. an immutable event and artifact log;
2. exact authority, task obligations, and deterministic working state;
3. a lossy model-visible handoff plus a recent complete tail;
4. optional cross-session claims with provenance, revalidation, expiry, contradiction handling, and a measured harm gate.

Terminus already has the harder foundations: exact Context IR manifests, immutable CAS artifacts, atomic source-backed compaction, deterministic working-memory reconstruction, and durable memory disabled behind a harm gate. The concrete defect is that the live compaction controller is less rigorous than those contracts. Before this change it used the same 96,000-token trigger, 24,000-token tail, and 400,000-token summary ceiling for every model, while allowing model prose to restate the task goal.

The implemented candidate fixes that narrow control-plane gap. It derives a versioned policy from the selected provider/model budget, uses the selected model's calibrated tokenizer estimator after a conservative metadata preflight, persists an exact obligation subset beside the lossy narrative, preserves recursive summary lineage, and emits the decision limits in telemetry. The Context Compiler still hard-includes the complete task contract on every attempt. This change does **not** enable durable semantic memory.

## What current public harnesses do

| Harness | Public mechanism inspected | Useful pattern | Limitation for Terminus |
|---|---|---|---|
| OpenAI Codex | Local compaction replaces model history with retained user messages plus a generated summary; persistence records the replacement. Resume scans the durable rollout backward. The public memory pipeline separates bounded rollout extraction from serialized consolidation. | Durable history remains separate from the current model view; memory extraction and consolidation are different phases. | Repeated local compaction is explicitly lossy, and provider-native continuation cannot be Terminus's authority. |
| OpenCode | Pressure is computed against the model context window minus output/buffer reserves. The stored view is the latest compaction plus a retained tail, with typed context sources and epochs. | Model-relative trigger, hysteresis through retention, typed context epochs. | The generated summary still carries model-authored task state and is not exact source authority. |
| Pi | Uses a context-window reserve and recent-token tail, legal cut boundaries, an append-only JSONL session tree, `firstKeptEntryId`, and cumulative file state. | Never split tool exchanges; preserve a branchable durable log and deterministic file state. | Its own documentation treats compaction as lossy; summary state cannot replace exact obligations. |
| Grok Build | Exposes summary, transcript, and segment compaction modes; supports token/percentage triggers, preserved plan state, and cache accounting. | Make strategy and threshold explicit; measure cache effects. | Configurability is not evidence that one mode generalizes across models and task cohorts. |
| Hermes Agent | Batch compaction protects head/tail state and atomically archives replaced messages. Optional micro-compaction rewrites old tool output incrementally. Memory files are bounded and user-visible. | Protect authority and recent state; archive before replacement; keep durable memory inspectable. | Its documentation notes that micro-compaction breaks cache reuse every turn, so it is a poor default without measured benefit. |
| Gemini CLI | Model-relative compression plus hierarchical `GEMINI.md` instruction loading; failed compression can fall back and suppress repeated attempts. | Fail closed and avoid retry loops; keep repository authority outside chat summaries. | Experimental algorithms are not production evidence, and compression still loses conversation detail. |
| Aider | Recursively summarizes older history while retaining a tail; builds a ranked, token-capped repository map separately. | Separate conversation compression from codebase retrieval. | Recursive prose summaries accumulate error unless exact source remains reachable. |
| SWE-agent | Configurable history processors retain tagged messages and insert explicit omission markers; pruning is batched to reduce cache churn. | Make omission visible and avoid needless prefix rewrites. | A processor policy alone does not preserve task or source provenance. |
| OpenHands SDK | Condensers transform a persistent event stream while protecting selected initial/recent events. | Treat condensation as a view over durable events. | A reported failure shows one-time skill/path instructions can disappear after condensation while activation state prevents reinjection. Policy must not live only in the condensable stream. |

Primary evidence: [Codex local compaction](https://github.com/openai/codex/blob/94cbbddafc1776d5e377bca1b05932c697e82238/codex-rs/core/src/compact.rs), [Codex rollout recovery](https://github.com/openai/codex/blob/94cbbddafc1776d5e377bca1b05932c697e82238/codex-rs/rollout/src/model_context.rs), [Codex memory pipeline](https://github.com/openai/codex/blob/94cbbddafc1776d5e377bca1b05932c697e82238/codex-rs/core/src/memories/README.md), [OpenAI response compaction](https://developers.openai.com/api/docs/guides/compaction), [OpenCode compaction](https://github.com/anomalyco/opencode/blob/10765ff2a9da8c3b88e4de873aa383a49c318912/packages/core/src/session/compaction.ts), [OpenCode context epochs](https://github.com/anomalyco/opencode/blob/10765ff2a9da8c3b88e4de873aa383a49c318912/packages/core/src/session/context-epoch.ts), [Pi compaction implementation](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/core/compaction/compaction.ts), and [Pi compaction documentation](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/docs/compaction.md).

Additional evidence: [Grok Build session compaction](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d/crates/codegen/xai-grok-shell/src/session/helpers/session_compact.rs), [Hermes micro-compaction](https://github.com/NousResearch/hermes-agent/blob/4f22543509d1/docs/micro-compaction.md), [Hermes native compaction](https://github.com/NousResearch/hermes-agent/blob/4f22543509d1/agent/native_compaction.py), [Gemini CLI chat compression](https://github.com/google-gemini/gemini-cli/blob/0bd1d4397514/packages/core/src/context/chatCompressionService.ts), [Aider history summarization](https://github.com/Aider-AI/aider/blob/5dc9490bb35f/aider/history.py), [SWE-agent history processors](https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f3/sweagent/agent/history_processors.py), [OpenHands condenser contract](https://github.com/OpenHands/software-agent-sdk/blob/704cbe6015e3/openhands-sdk/openhands/sdk/context/condenser/base.py), and [OpenHands issue 4544](https://github.com/OpenHands/software-agent-sdk/issues/4544).

## Industry pattern and design consequences

### Window pressure must be model-relative

Codex, OpenCode, Pi, Hermes, and Gemini CLI all relate compression pressure to the active model window or its reserve. A single global trigger is unsafe in both directions: it can exceed a small model's safe input before compaction, or pay summary and cache-invalidation cost too early on a large window.

Terminus already reconciles advertised capacity, tested-safe capacity, output, reasoning, tool-result, and recovery reserves into `ContextBudget`. The compactor should consume that decision instead of creating a second budget model. The candidate policy uses 75% of `optionalContextTarget` as the trigger and a bounded 25% tail as hysteresis. These ratios are hypotheses, not promoted constants; their version and derived values are observable.

### The task contract cannot be model prose

Every summarizer can omit, distort, or invent. This is especially dangerous for acceptance criteria, scope, approvals, and unresolved blockers. The OpenHands condensation failure is direct evidence that one-time instructions can disappear if the system remembers only that they were activated.

The compaction artifact now contains an exact obligation anchor: contract version/hash, objective, acceptance criteria and status, non-goals, constraints, and allowed scope. The summary model receives this as a separate exact fragment. Its narrative is clearly labeled lossy and cannot override the anchor. This subset does not replace `userOutcome`, verification hints, assumptions, unknowns, risk, budget, or change policy; those remain in the complete task contract reconstructed by the Context Compiler.

### Compaction is a provenance graph

Repeated summarization compounds loss. Pi and Codex preserve durable session structure; Terminus goes further by retaining immutable source artifacts and an exact recall tool. A second-generation summary now identifies absorbed summary hashes as typed parents. This makes the earlier source path discoverable without parsing model prose.

### Memory is not session recovery

Session history, reconstructed working state, and cross-session semantic memory have different trust and lifecycle rules. Codex's public memory pipeline is bounded and staged; Hermes exposes bounded user-visible memory. Neither justifies injecting unverified cross-session beliefs into a coding task.

ADR-0023 remains correct: durable semantic memory stays off until paired held-out evaluation shows useful retrieval with acceptably low stale/contradictory harm. Long-horizon continuity should first be improved through exact task state, deterministic reconstruction, episodic source recall, and restart equivalence.

## Terminus change in this branch

- `terminus.adaptive-compaction.v1` derives the trigger, retained tail, summary hard limit, and maximum source chunk from the live `ContextBudget` only when explicitly selected. Unavailable capacity or degraded tokenizer calibration falls back to the exact fixed-byte control path, including its loader, trigger, retained tail, and summary chunk ceiling, rather than treating unsafe estimates as provider limits.
- CAS byte metadata is a no-read preflight only. Candidate sources are measured with the selected model's tokenizer estimator before pruning and every summary chunk is rechecked. Calibrated estimates carry observed-error headroom; degraded estimates use a conservative UTF-8 byte bound. Unavailable metadata forces materialization.
- `ToolEpisodeService` accepts the live token window instead of hiding history behind its legacy fixed byte cap.
- `terminus.compaction-summary.v2` stores the exact obligation subset and typed parent-summary lineage.
- The fixed summary scaffold is checked before provider spend. The finalized summary plus retained tail must fit both the model-visible UTF-8 artifact limit and the selected context allocation before any source is hidden; the committed summary and exact retained tail are hard-required on the next compiler pass.
- An identical failed source/anchor/policy fingerprint is suppressed for the remainder of the turn, preventing repeated summary spend without suppressing a changed history.
- Episode bodies and the model-produced narrative are JSON-serialized as untrusted data. The summary prompt forbids following embedded instructions, and the required replacement remains `untrusted` with `high` injection risk on later compiler passes.
- The live summarizer renders authority, the exact obligation subset, and transcript as distinct fragments; only the transcript is derived/untrusted task history.
- `context.compacted` and `context.compaction_deferred` events expose policy version, source, derived limits, measured pressure, and stable failure categories.
- Source episodes remain visible unless an atomic source-backed summary commit succeeds.
- A conformance test crosses a serialization boundary, restores the persisted obligation anchor, and expands pruned source from the restart-bound recall store. It is not a full Prisma/process-restart/next-manifest test.

The governing decision is [ADR-0055](../decisions/ADR-0055-budgeted-obligation-anchored-compaction.md). The implementation is a candidate on an isolated branch. Because it changes context policy, it still requires the paired evaluation record and two approvals before merge.

## Evaluation and promotion gate

The minimum useful comparison is fixed-policy anchored compaction versus `terminus.adaptive-compaction.v1`, paired on identical task/model/seed inputs.

Target cohorts:

- `compaction_mid_implementation` for requirement retention, exact recall, summary failure, and continuation;
- `interruption_resume` for restart equivalence and duplicate-effect avoidance;
- a small-window model stratum where the old 96k trigger is above the safe history allocation;
- non-compaction regression tasks to measure unnecessary summary calls and prompt-cache churn.

Required metrics:

- verified successful tasks per dollar-hour;
- required acceptance criteria recalled after compaction;
- exact scope and constraint retention;
- source recall expansions and failures;
- provider input/output/cached tokens;
- summary calls, failures, and retry escapes;
- stable-prefix/cache-read rate;
- duplicate or missing effect settlements after restart.

Promotion is blocked until paired evidence shows no safety or requirement-recall regression, no unacceptable cohort regression, and a primary-metric improvement or a documented reliability necessity. Durable semantic memory has a separate harm gate and is outside this experiment.

## Limitations

- Claude Code's public repository does not expose its proprietary compactor, so this report makes no internal algorithm claim about it.
- Public source establishes mechanisms, not comparative task success. Project benchmark claims were not treated as proof of compaction quality.
- The source links pin the inspected snapshots. Later upstream behavior may differ from commits `bc7f02eddd3d`, `4f22543509d1`, `0bd1d4397514`, `5dc9490bb35f`, `3ea751c087f3`, and `704cbe6015e3`.
- The deterministic tests in this branch are local evidence. They do not replace a live provider run, the paired cohort, CI, or merge approvals.

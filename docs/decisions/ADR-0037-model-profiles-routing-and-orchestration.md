# ADR-0037: Deep model profiles, deterministic routing, and expected-value orchestration

- **Status:** ADOPTED
- **Date:** 2026-08-23
- **Decision owner:** runtime architecture owner + model router owner + orchestration owner
- **Supersedes:** none
- **Related:** `Terminus — Research/roadmap.md` (Phase 8), SPEC §26 (Model Profiles and Context Routing), §27 (Multi-Agent and Subagent Orchestration), §38 (Model Routing and Escalation), ADR-0020 (Single-agent default and expected-value scheduling), ADR-0022 (Deterministic model routing before learned routing)

## Context

Production coding agents frequently suffer from two failure modes:
1. **Generic model prompts and uniform assumptions:** Treating all frontier and open-weight models as identical generic LLMs leads to dialect mismatches (tool schemas, edit diff syntax, reasoning tokens, cache invalidation), unhandled provider rate/quota failures, and unrepairable structured output corruptions.
2. **Uncontrolled multi-agent sprawl and echo-chamber reviews:** Naive agent frameworks spawn parallel subagents indiscriminately, creating severe coordination overhead, token waste, git merge conflicts, and self-review biases where an agent validates its own flawed changes.

Phase 8 solves both challenges end-to-end:
- **Deep Model Profiles:** Pinned, versioned profiles specialize instructions, context layouts, tool dialects, edit diff formats, reasoning effort policies, prompt caching breakpoints, structured output repair mechanisms, error mitigations, economics, latency models, and confidentiality policies across Anthropic, OpenAI, Google, and Local open-weight models.
- **Stage-Aware Deterministic Routing & Bayesian Posteriors:** Workflow nodes route dynamically based on their role (`classifier`, `implementer`, `reviewer`, `specialist`, `vision`, `local_safe`), updating conjugate Beta-Binomial reliability and Log-Normal latency posteriors from real execution telemetry.
- **Expected-Value Subagent Scheduler:** Multi-agent spawning is strictly constrained by a mathematical expected-value formula:
  $$EV = \text{InfoGain} + \text{SpecializationGain} + \text{ParallelSpeedup} - \text{TokenCost} - \text{CoordinationCost} - \text{ConflictRisk} - \text{ReviewCost}$$
- **Clean-Context Independent Reviewers:** Reviewers receive clean context (task contract, candidate diff, verification evidence) without actor rationalizations, with model family diversity preferred and read-only authority enforced.
- **Stagnation & Safety Supervisor:** Long tasks run under an independent supervisor monitoring 11 stagnation signals (loops, rereads, oscillation, diagnostic stagnation, strategy repetition, burn ratio, confidence collapse) with an escalating structured intervention ladder.
- **Isolated Candidate Workspaces:** Speculative writers run in candidate workspaces with read-only effect epochs; losing branches are discarded cleanly and authoritative merge is gated by the admission service.

## Decision

### 1. Deep Model Profiles and Profile Registry (SPEC §26.1–§26.3)

All model invocations MUST resolve an immutable `ModelProfile` containing:
- `id`, `providerId`, `modelKey`, `version`;
- `contextLayout`: system prompt placement, max tokens, tested safe tokens, image support;
- `toolDialect`: `anthropic_tools`, `openai_function_calling`, `gemini_function_declarations`, `standard_json_schema`;
- `editDialect`: `hash_anchored_diff`, `search_replace_blocks`, `whole_file`;
- `reasoningEffortPolicy`: `none`, `low`, `medium`, `high`;
- `continuationStrategy`: `native_token`, `server_history`, `client_replay`;
- `compactionStrategy`: `structured_claims_with_evidence`, `rolling_summary`, `hierarchical_epoch`;
- `cachingStrategy`: `explicit_breakpoints`, `automatic_prefix`, `explicit_resource`, `none`;
- `structuredOutputRepair`: `strict_json_schema`, `prompt_guided_json`, `grammar_constrained`;
- `knownFailureMitigations`: error sanitizers and prompt adjustments;
- `economics` & `latencyModel`: micro-cost and distribution parameters;
- `confidentialityPolicy`: allowed confidentiality classifications (`public`, `workspace`, `secret_adjacent`, `secret`).

### 2. Conjugate Bayesian Performance Posteriors (SPEC §26.4)

The router maintains `ModelCohortPosterior` distributions updated online via:
- Beta-Binomial conjugate updates for discrete event success (tool reliability, structured output, edit cohort);
- Log-Normal online updates for execution latency;
- Running averages for costs and cache hit rates.

### 3. Stage-Aware Deterministic Router (SPEC §26.4, §38.3)

The router matches workflow node stage and confidentiality requirements:
- `classifier`: optimizes for TTFT and low latency;
- `implementer`: optimizes for high coding quality, edit success, and tool reliability;
- `reviewer`: maximizes security reasoning and enforces model family diversity from the implementer;
- `specialist`: engages high reasoning effort models;
- `vision`: selects models with verified multimodal support;
- `local_safe`: restricts routing exclusively to local open-weight models for offline or strict secret confidentiality.

### 4. Expected-Value Scheduling & Candidate Isolation (SPEC §27.1–§27.3)

- Parallel workers are spawned only when $EV > \text{Threshold}$.
- Writers run in isolated candidate worktrees/workspaces without external effect authority.
- High-risk write work prohibits parallel speculative writers by default.

### 5. Independent Clean-Context Reviewers (SPEC §27.4)

- Reviewers evaluate only contract, candidate diff, evidence, and risk.
- Authority is strictly read-only; reviewers cannot merge their own recommendations.

### 6. Stagnation Supervisor & Escalating Intervention Ladder (SPEC §27.5)

The supervisor evaluates 11 diagnostic signals and triggers:
- `none` $\to$ `warn` $\to$ `change_strategy` $\to$ `spawn_scout` $\to$ `request_user_decision` $\to$ `terminate`.

## Consequences

- Dialect mismatches, tool call formatting failures, and cache churn are minimized across providers.
- Subagent sprawl and uncontrolled token consumption are mathematically prevented.
- Code review is rigorous, adversarial, and isolated from implementer bias.
- Tasks that loop or stall are promptly detected and escalated with structured choices.

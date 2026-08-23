# Phase 8 — Model Profiles, Stage Routing & Expected-Value Orchestration

**parent:** [Wayfinder Map — Phase 8 Deep Model Profiles, Routing & Expected-Value Orchestration](wayfinder-phase-8-map.md)
**label:** wayfinder:task
**status:** complete
**assignee:** codex

## Question

What implementation and evidence are required to make Phase 8 real on this
checkout, including any Phase 0–7 gap that blocks its acceptance surface?

## Acceptance

- Deep Model Profiles for Anthropic (Claude 3.7 Sonnet, Claude 3.5 Haiku), OpenAI (GPT-4o, o3-mini), Google (Gemini 2.0 Flash, Gemini 1.5 Pro), and Local open-weight models (Llama 3.3 70B, Qwen 2.5 Coder 32B, DeepSeek R1 Distill 32B) with tested-safe tokens, caching breakpoints, structured output repair, and error mitigations;
- Profile Registry supporting pinned resolution, provider filtering, offline/local discovery, and confidentiality policy enforcement;
- Empirical Performance Posterior tracking online conjugate Beta-Binomial reliability and Log-Normal latency metrics;
- Stage-aware deterministic router scoring and selecting optimal profiles for workflow node stages (classifier, implementer, reviewer, specialist, vision, local_safe) with circuit-breaker and rate-limiter awareness;
- Provider Failure & Resumable Continuation manager classifying error categories (timeout, rate limit, quota, refusal, format) and preserving continuation state;
- Expected-Value Subagent Scheduler computing net EV from information gain, specialization, and parallel speedup against token, coordination, conflict, and review costs, emitting DelegationContractV2;
- Candidate Workspace Manager isolating speculative writers in worktrees/branches and gating authoritative merges via the admission service;
- Clean-Context Independent Reviewer stripping author rationalizations, enforcing read-only authority, and evaluating findings with model family diversity;
- Stagnation & Safety Supervisor detecting 11 loop/stagnation signals and executing the structured intervention ladder;
- Public API endpoint definitions in `@terminus/public-api`, client SDK methods in `@terminus/public-client`, and control plane routes in `terminus-control`;
- `ADR-0037` recorded and all verification suites (`just codegen-check`, `just check`, `just check-all`, `just eval-smoke`) passing with zero failures.

## Resolution

Implemented Phase 8 end-to-end across `@terminus/domain`, `@terminus/model-router`, `@terminus/orchestration`, `@terminus/public-api`, `@terminus/public-client`, and `terminus-control`. All unit tests, codegen checks, integration suites, and smoke evaluations pass cleanly. ADR-0037 recorded.

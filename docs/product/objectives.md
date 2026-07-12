# Product objectives

This document states Terminus's product objective, derived from SPEC §1 and §26. The normative source is `SPEC.md`; this document is a summary for product, design, and engineering reference.

## Product definition (SPEC §26.1)

Terminus is a **local-first coding-agent operating system** that can inspect, modify, execute, test, review, and explain software changes while preserving an exact record of model inputs, environmental effects, security decisions, evidence, cost, and uncertainty.

Terminus is not merely a conversational CLI. The durable product is the combination of:

- a task and session runtime;
- a canonical Context Compiler;
- a provider-neutral model broker;
- a non-bypassable effect kernel;
- an artifact and evidence store;
- a verification engine;
- a capability-secured extension system;
- a selective agent scheduler;
- client surfaces;
- and an evaluation laboratory.

## Behavioral contract (SPEC §26.1)

- A UI process MAY disconnect without stopping a task.
- A model provider MAY change between compatible turns.
- An execution worker MAY crash and be reconciled.
- A task MUST NOT be considered complete solely because a model produced a completion statement.

## Primary objective (SPEC §1, §26.6, ADR-0001)

Maximize **verified successful tasks per dollar-hour**:

```
verified_successful_tasks
──────────────────────────────────────────────────────────────
model_cost + compute_cost + elapsed_time_cost + human_attention
```

The denominator is reported as separate components as well as any composite. No single aggregate score may conceal a safety regression.

## Goals (SPEC §26.4)

Terminus SHALL:

- maximize verified task success subject to cost, latency, security, and maintainability constraints;
- support multiple model providers and local models without leaking provider concepts into the canonical domain;
- support local, container, micro-VM, and remote workspaces through one capability model;
- make context assembly inspectable and replayable;
- make exact effects and evidence auditable;
- permit controlled interruption, resume, fork, replay, and counterfactual evaluation;
- keep simple tasks cheap and fast;
- make sophisticated features optional and measurable;
- allow clients and IDEs to evolve independently of the privileged runtime;
- provide a secure path for skills, MCP, plugins, and external agents;
- preserve a minimal shell-oriented baseline indefinitely.

## Non-goals for the first production release (SPEC §26.5)

The first production release SHALL NOT attempt to provide:

- unrestricted computer-use automation across the user's desktop;
- covert browser automation or anti-bot evasion;
- autonomous production deployment without explicit policy and approval;
- a public uncurated plugin marketplace;
- permanent model-generated memory by default;
- a learned router trained on insufficient or contaminated local data;
- universal semantic embeddings of every repository file;
- automatic multi-writer swarms;
- a proprietary model training platform;
- full enterprise multi-tenancy before single-user isolation and recovery are proven;
- formal verification of arbitrary generated code.

## Non-negotiable invariants (SPEC §26.3)

1. No ambient effects.
2. No hidden model input.
3. No completion by assertion.
4. No silent truncation.
5. No stale write.
6. No raw model-visible secrets.
7. No destructive compaction.
8. No implicit extension authority.
9. No blind retry of uncertain effects.
10. No unpinned experiment as a default.
11. No unreported degradation.
12. No uncontrolled upstream divergence.

These are release blockers. See `docs/architecture/trust-boundaries.md` for enforcement.

## Why this matters

Most coding-agent harnesses optimize for raw task success on a single benchmark, hide cost behind "tokens" without breaking out compute/wall-clock/human attention, or aggregate everything into one number that conceals safety regressions. Terminus's objective is different: verified completion (not model-asserted), full cost transparency, and safety regressions visible separately. The architecture (Rust kernel + TS control plane + Python eval lab + permanent minimal baseline + feature promotion gates) exists to serve this objective.

## Related

- `docs/product/modes.md` — product modes (explain, plan, edit, autonomous, review, research, eval, admin).
- `docs/product/metrics.md` — success metrics dashboard.
- `docs/decisions/ADR-0001-verified-successful-tasks-per-dollar-hour.md` — the founding decision.
- SPEC §1, §26.

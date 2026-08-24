# Terminus — Next Implementation Plan

**Revision basis:** `0cd373cef6d568df4891c84032d43b49f08e076e`  
**Date:** August 24, 2026  
**Purpose:** the shortest credible route from the current architecture-heavy experimental repository to a benchmark-leading, daily-usable coding harness.

## North-star decision

Terminus is a **profile-driven shared agent runtime**, not one uniformly heavy harness.

The first profile to build is **Native Performance**: a thin, provider-native coding loop with compact tools, exact transcripts, stable-prefix caching, fast repository evidence, brokered effects, durable state, and independent verification. The richer governed, cloud, multi-agent, computer-use, and self-improving systems remain behind explicit profiles and must earn activation through measured expected value.

## Non-negotiable rules

1. No new major subsystem until one live end-to-end coding spine works.
2. No feature enters a default profile without telemetry, an ablation, and an owner.
3. No provider neutrality that destroys provider-native tool, cache, reasoning, media, continuation, or streaming semantics.
4. No model-facing TypeScript, plugin, MCP server, extension, or external harness can bypass the Rust effects broker.
5. One authoritative writer by default; read-only scouts/reviewers are the first multi-agent topology.
6. Completion requires revision- and environment-bound independent evidence.
7. Repository claims are generated from executable probes and benchmark artifacts.
8. Experimental compatibility may be broken when it obstructs simplification.

## Immediate freeze

Do not add more adapters, agent roles, providers beyond the first two, remote sandbox vendors, computer-use surfaces, marketplace systems, learned routers, or enterprise dashboards. Continue security fixes and critical maintenance, but direct feature work to the spine below.

## Build order

### PR 1 — Executable truth and `terminus doctor`

Deliver:

- database/schema/migration check;
- Rust kernel protocol and service probes;
- current sandbox strength and unsupported-boundary report;
- provider configuration, model catalogue, and admission report;
- connector stream/cancel probe;
- workspace/Git/patch/process/job/verifier checks;
- client protocol/version check;
- signing/SBOM/benchmark availability report;
- generated support and maturity matrix;
- stale `terminus-dashboard` package naming and unrelated dependency cleanup.

Gate:

- a new checkout can state exactly which path is live, blocked, stubbed, or unsafe;
- production mode refuses to start when a claimed invariant is missing.

### PR 2 — Provider transcript conformance laboratory

Deliver golden semantic episodes for:

- system/developer/user/assistant messages;
- text and reasoning deltas;
- one and multiple tool calls;
- linked tool results and tool errors;
- parallel/sequential tools;
- structured output;
- images/documents;
- cache controls and cache observations;
- usage and cost reconciliation;
- refusal, truncation, retry, cancellation, and continuation.

Targets:

- OpenAI Responses;
- Anthropic Messages;
- semantic IR round-trip and explicit downgrade errors.

Gate:

- every renderer can prove that its emitted request and parsed event stream preserve the episode semantics.

### PR 3 — Native OpenAI Responses connector

Deliver:

- Rust-brokered credential and egress;
- true frame streaming to the control service;
- backpressure, deadline, cancellation, retry, and ambiguous-outcome state;
- native response/continuation IDs;
- exact tool-call/result IDs;
- reasoning and structured-output controls;
- provider-reported usage/cache receipt;
- opt-in live conformance tests.

### PR 4 — Native Anthropic Messages connector

Deliver the same production standard, including native `tool_use`/`tool_result`, thinking controls, cache blocks, media, and streaming events.

### PR 5 — Model catalogue and profile admission

Deliver:

- implemented catalogue fetch;
- hash/signature-pinned online response;
- committed offline snapshot;
- cache, expiry, refresh, and failure rules;
- explicit model/profile admission record;
- model/version capability probes;
- loss/downgrade metadata;
- no hard-coded generic context or pricing assumption without provenance.

Gate:

- a fresh install can admit a supported model without internal database editing.

### PR 6 — Minimal coding ACI v1

Always visible:

1. `read`
2. `search`
3. `edit`
4. `shell`
5. `job`
6. `inspect`
7. `capability`

Requirements:

- compact provider-tuned descriptions;
- definition hash included in active tool-set/cache identity;
- source version on reads;
- expected hash/revision on writes;
- hash-anchored replace;
- transactional patch;
- exact conflict response;
- automatic batched diagnostics after writes;
- bounded shell and durable/background jobs;
- output summary plus artifact continuation;
- typed errors;
- tool-schema token accounting.

Gate:

- randomized model/tool episodes show high first-call correctness and low correction-turn rate.

### PR 7 — Complete end-to-end turn spine

Launch in one integration test:

- real database;
- real Rust kernel;
- real control service;
- deterministic streaming fake provider speaking the exact protocol;
- temporary Git repository;
- real read/search/edit/shell/job tools;
- independent verifier;
- reconnecting client.

Prove:

- prompt/context manifest;
- provider request/event ordering;
- tool execution through the broker;
- edit and revision creation;
- verification;
- completion proof bundle;
- cancellation;
- disconnect/reconnect;
- restart mid-turn;
- duplicate command idempotency;
- artifact integrity.

Gate:

- one task goes from request to independently verified completion without a mock at the critical provider/tool/effect boundaries.

### PR 8 — Decompose the control-service monolith

Extract around authoritative responsibilities:

- `TurnCoordinator`
- `ProviderSessionService`
- `ToolEpisodeService`
- `EffectSettlementService`
- `VerificationCoordinator`
- `TaskProjectionService`
- `EventSubscriptionService`

Rules:

- preserve the PR 7 end-to-end test;
- expose transaction boundaries;
- do not introduce a new framework;
- remove duplicated lifecycle logic as it becomes visible.

### PR 9 — Authoritative durable task/effect store

Deliver:

- command deduplication;
- optimistic versions/CAS;
- transactional event append + projection + outbox;
- inbox and replay protection;
- database-allocated task/thread/turn/epoch sequences;
- transactional epoch replacement;
- durable provider attempts/native IDs;
- durable tool episodes and effect settlement;
- worker leases and fencing;
- explicit uncertain state and reconciliation;
- deterministic projection rebuild.

Gate:

- the in-memory `DurableTaskRepository` is no longer an authoritative production path;
- control and kernel no longer maintain competing lifecycle models.

### PR 10 — Durable jobs and log streams

Deliver:

- database-backed job/process identity;
- atomic-enough spawn/persist protocol with recovery record;
- PID reuse defense;
- worker lease/fencing;
- durable stdout/stderr chunks or artifact log segments;
- resume offsets and bounded retention;
- restart discovery and settlement;
- kill/cancel/escalation semantics;
- persistence failure surfaced, never ignored.

Gate:

- a process can outlive control restart and be correctly observed, cancelled, or reconciled.

### PR 11 — Independent verification and proof bundles

Deliver:

- task acceptance criteria compiled to predicates;
- trusted repository commands and hidden tests;
- static analysis/security checks;
- verifier-isolated workspace and credentials;
- revision/environment binding;
- immutable evidence artifacts;
- claim-to-evidence graph;
- explicit human acceptance obligation for subjective criteria;
- adversarial tests where the agent edits tests, verifier config, or evidence.

Gate:

- malicious self-authored evidence cannot produce a completed state.

### PR 12 — Real benchmark adapters

Deliver:

- Harbor agent adapter;
- Terminal-Bench 2.0 manifest and run path;
- corrected SWE-bench Verified metadata and real pinned image/dataset revisions;
- rotating fresh/private SWE repair cohort;
- minimal-shell control;
- Terminus Native Performance profile;
- Pi and other accessible baselines;
- exact model/harness/profile/effort/task/seed/environment manifest;
- paired success, cost, time, token/cache, tool, recovery, and human-attention report;
- replayable artifacts.

Gate:

- Terminus can quantify its harness contribution under the same model and task conditions.

## The next three milestones

### Milestone A — Native Spine Alpha

Required:

- macOS and Linux install;
- `terminus doctor` passes;
- native OpenAI + Anthropic;
- TUI + headless CLI on one runtime;
- compact coding ACI;
- Rust-brokered effects;
- transactional local state;
- restart/resume;
- independent proof bundle;
- local repair benchmark and minimal-shell control.

Explicitly not required:

- external harness adapters;
- multi-agent writers;
- cloud/microVM;
- browser/desktop use;
- marketplace;
- self-improving harness.

### Milestone B — Benchmark Candidate

Required:

- Harbor/Terminal-Bench 2.0;
- fresh SWE and multi-language cohorts;
- real token/cache accounting;
- stable-prefix debugger;
- retrieval/context ablations;
- 24-hour fault-injection soak;
- security adversarial suite;
- same-model comparison against strong baselines;
- published replay artifacts.

Promotion condition:

- statistically credible same-model advantage or Pareto improvement without failing security, durability, or verification gates.

### Milestone C — Daily Driver

Required:

- polished TUI, desktop supervisor, and IDE client over the same event protocol;
- prepared environments;
- project knowledge with provenance;
- signed release, SBOM, reproducible-build evidence, update and rollback;
- stable session continuity and human-intervention metrics;
- no recurring hidden manual environment repair.

## Work after the spine wins

Order:

1. calibrated tokenization, retrieval, stable-prefix caching, deferred schemas, and handoffs;
2. deterministic role routing and read-only scout/reviewer/oracle;
3. task-conditioned routing and expected-value delegation trained on verified outcomes;
4. worktree-isolated parallel writers;
5. declarative prepared environments and one cloud microVM provider;
6. organization knowledge, issue/source-control/chat/deploy effects;
7. semantic browser control, then typed desktop control and visual fallback;
8. sealed evolution lab with reviewable diffs, held-out eval, canary, signing, and rollback.

## Metrics required from the first live task

- verified success and criterion-level results;
- model/provider/profile version;
- request/context/tool-schema tokens;
- fresh/cached input and output/reasoning usage;
- cache prefix/epoch and invalidation reason;
- tool calls, corrections, errors, and retries;
- changed files, edit conflicts, and reverts;
- targeted and acceptance verification;
- provider, tool, and external-effect ambiguity;
- wall-clock, compute, and model cost;
- human questions, approvals, interventions, and minutes;
- exact environment and repository revision;
- immutable replay/proof artifact.

## Stop conditions

Pause and repair the architecture when any of these appears:

- two sources of truth for task/effect state;
- any model-facing path can perform an unbrokered effect;
- generic provider abstraction requires loss of native semantics;
- a feature cannot be independently disabled and ablated;
- a “durable” implementation is process-local in the production profile;
- a client owns execution or durable state;
- completion can occur without independent evidence;
- benchmark metadata contains placeholders or cannot be replayed;
- new complexity is justified only by intuition or competitor feature parity.

## First implementation move

Build **PR 2 + PR 3 + PR 6 + PR 7 as one coordinated vertical program**: provider conformance, a native OpenAI path, the compact coding ACI, and the end-to-end turn spine. Keep PRs independently reviewable, but do not allow parallel architecture expansion to distract from reaching the first live verified coding task.

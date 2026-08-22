# Terminus Evolution Roadmap

## 1. Strategy

The current repository should evolve through a **truth-first strangler migration**. Do not rewrite everything and do not keep layering features over process-local semantics.

The ordering is intentional:

1. establish what works;
2. make state and effects correct;
3. make context and workflows intelligent;
4. make clients and computer use exceptional;
5. make the system self-improving;
6. prove dominance.

A phase does not advance because code exists. It advances when its exit evidence is signed and reproducible.

## 2. Program principles

- No new “production” label without conformance.
- The minimal mode remains running through every phase.
- Current clients may continue against compatibility adapters while ARP v2 is built.
- Existing Rust process/fs/Linux sandbox work is reused as worker primitives.
- Current in-memory durability/authority implementations are not migrated as-is.
- Security-critical paths are completed before marketplace/ecosystem expansion.
- Every phase adds eval tasks before or with implementation.
- The product remains usable during migration.
- Theoretically best architecture is the target; temporary compromises are explicit and time-bounded.

## Phase 0 — Truth, reproducibility and freeze

### Goal

Create a reliable baseline and stop semantic overclaiming.

### Work

- protect the actual default branch;
- fix CI triggers and malformed jobs;
- run `just bootstrap`, `check-all`, `e2e`, `eval-smoke`, Linux evidence and release recipes in clean environments;
- classify every component: fixture, stub, experimental, preview, production;
- generate platform/backend support from conformance;
- replace README counts with generated evidence;
- mark adapters with `lastVerified`, exact probe and status;
- eliminate hard-coded empty limitations;
- produce first system card;
- freeze architecture-expanding feature work.

### Exit gate

- exact HEAD has required green runs;
- all failures and missing infrastructure are recorded;
- no source declaration contradicts release metadata;
- baseline eval results and costs are signed;
- every “durable/enforced/non-bypassable/production” claim maps to a test artifact.

## Phase 1 — ARP v2 and canonical domain

### Goal

Create the stable seam that all clients and future replacements share.

### Work

- define canonical IDs/entities/events/commands;
- implement schema registry and code generation;
- task, workflow, claim, evidence, artifact, effect and capability APIs;
- resumable event streams and cursors;
- expected-version and idempotency semantics;
- compatibility gateway for current clients/protocol;
- ACP/MCP/A2A/AG-UI/ATIF boundary adapters;
- conformance test kit and fixture server.

### Reuse

- current protocol/codegen structure;
- current artifact schemas where compatible;
- current client SDK generation patterns.

### Exit gate

- CLI and one graphical client use ARP v2 for the same task;
- protocol fuzz/property tests;
- backward-compatibility contract;
- no OpenCode-internal type leaks into canonical API.

## Phase 2 — Durable task substrate

### Goal

Replace process-local authoritative state.

### Work

- relational/materialized state;
- semantic event log;
- transactional outbox/inbox;
- task/workflow/attempt/node state machines;
- durable questions, decisions, risks and budgets;
- worker leases and fencing epochs;
- local embedded and managed HA deployment modes;
- backup/restore/migration drills.

### Replace

- in-memory `JobManager` as authoritative job state;
- process-local approval/revocation/nonce/audit stores.

### Exit gate

- control process killed at every transition;
- task resumes with no lost/duplicated transition;
- stale workers cannot commit;
- backup/restore/rollback drills pass;
- local crash-safe mode and managed failover pass.

## Phase 3 — Transactional effects and authority

### Goal

Make every mutation safe, attributable and recoverable.

### Work

- Effect Ledger;
- semantic idempotency keys;
- effect classes;
- uncertainty/reconciliation;
- compensation and residue;
- durable authorization instances and consumption;
- compiled sequence policy;
- exact approval UI;
- object-capability handles;
- separation-of-duty and admission authority.

### Replace

- operation-hash scan/consume model;
- broad reusable capability tokens;
- direct authoritative local mutation paths.

### Exit gate

- full effect fault matrix;
- zero duplicate committed effects;
- approval cannot be replayed after crash/replan/version change;
- every effect resolves to principal/task/policy/authorization/evidence;
- static/runtime non-bypassability tests.

## Phase 4 — Secret, connector and sandbox TCB

### Goal

Remove raw credentials and make enforcement claims true.

### Work

- workload identity and short-lived grants;
- L7 connector broker;
- credential injection inside trusted connectors;
- retain L4 DNS/IP egress broker as lower layer;
- hardened OCI profiles;
- microVM backend selection and implementation;
- strict Linux conformance;
- real macOS Seatbelt profile generation or secure VM fallback;
- real Windows AppContainer/Job Object implementation or WSL2/VM fallback;
- effective-control probes;
- sandbox tier policy and residue scanning.

### Replace

- `SecretHandle::value/as_env_pair` in production;
- in-memory provider as anything but fixture;
- container report based on configuration flag;
- degraded-profile acceptance in secure modes.

### Exit gate

- raw-secret canary never appears in model/tool/log/artifact;
- platform support matrix generated from probes;
- critical escape/exfiltration suite passes;
- credential use is exact-operation bound;
- unsupported/degraded backends fail closed.

## Phase 5 — Context and State OS

### Goal

Turn context into a high-performance compiled projection of authoritative state.

### Work

- immutable evidence store;
- executable world model;
- versioned resource handles;
- repository graphs and code intelligence;
- context IR and provider renderers;
- trust/taint;
- cache manifest;
- semantic compaction;
- memory admission/expiry/contradiction;
- omission diagnostics and causal context replay.

### Reuse

- current context compiler, manifest and checkpoint work;
- bounded artifact spill;
- current retrieval/index infrastructure where valid.

### Exit gate

- controlled ablations against minimal/full-history baselines;
- better task success or cost frontier across multiple models;
- exact manifest reproduces invocation;
- stale/poisoned context tests;
- compaction never loses task/effect/approval invariants.

## Phase 6 — ACI, editing and verification

### Goal

Provide the strongest software-engineering interface and eliminate false completion.

### Work

- unified bounded read/search;
- lexical/semantic/AST/LSP/build/history retrieval;
- model-specific edit dialects;
- hash-anchored and AST edits;
- isolated patch transactions;
- LSP/DAP/compiler/test feedback;
- verification DAG compiler;
- claim/evidence graph;
- clean-context reviewers;
- semantic diff, visual acceptance and environment identity;
- admission service as sole authoritative merge.

### Exit gate

- edit-format/model factorial evals;
- no admitted stale/wrong-checkout artifact;
- target and regression tests selected correctly;
- frontend tasks verified in exact user-visible path;
- actor self-report cannot satisfy completion.

## Phase 7 — Workflow and skill compiler

### Goal

Combine dynamic orchestration with deterministic safety.

### Work

- Workflow IR and source language;
- natural-language/skill compiler with source provenance;
- owner-test classification;
- static types, reachability, temporal safety, taint, authority and resource validation;
- verify-repair-commit runtime;
- deterministic controller;
- reusable organizational workflows;
- generated workflow review UI.

### Exit gate

- skill-procedure adherence improves on held-out tasks;
- no arbitrary generated script owns privileged traversal;
- malicious/ambiguous skill tests;
- required-step coverage and witness paths;
- safe bounded loops and compensation checks.

## Phase 8 — Model profiles, routing and orchestration

### Goal

Exploit each model fully without model lock-in.

### Work

- profile registry;
- provider-specific context/tool/edit/cache/compaction;
- stage-aware deterministic router;
- cost/latency/performance posterior;
- subagent expected-value scheduler;
- isolated workers and merge admission;
- independent reviewers;
- stagnation supervisor;
- local/open-weight profiles;
- provider failure and continuation.

### Exit gate

- same-model harness comparisons;
- cross-model profile transfer;
- router beats fixed policy on holdout;
- orchestration benefit exceeds coordination cost;
- no security or tail-latency regression;
- minimal mode remains competitive.

## Phase 9 — Unified clients and operator cockpit

### Goal

Make Terminus the product people want to use every day.

### Work

- task-first CLI/TUI;
- native desktop;
- IDE via ACP and native capabilities;
- web/fleet;
- mobile supervision;
- one session/task identity;
- organization map, department workspaces, agent rooms;
- workflow/world/risk/effect/evidence views;
- attention coordinator;
- structured intervention;
- causal replay and understanding mode;
- accessibility and keyboard excellence.

### Exit gate

- start CLI → supervise desktop → approve mobile/web → inspect IDE;
- no continuity loss;
- user studies beat incumbent intervention/review metrics;
- approval comprehension and trust calibration;
- sub-100ms local UI updates for cached state where practical.

## Phase 10 — Computer use and general agency

### Goal

Make browser/desktop/cloud agency first-class without weakening safety.

### Work

- versioned UI observation model;
- screenshot + DOM/accessibility fusion;
- semantic target verification;
- before/after evidence;
- browser and desktop pools;
- human takeover;
- downloads/uploads/clipboard policy;
- external connector library;
- incident and research profiles;
- ambiguous-submit reconciliation.

### Exit gate

- computer-use benchmark leadership under controlled model;
- prompt-injection suite;
- zero duplicate submits in fault matrix;
- takeover/resume correctness;
- browser/desktop effects use same ledger and policy semantics.

## Phase 11 — Evolution Lab

### Goal

Create the compounding improvement engine.

### Work

- structured trace attribution;
- failure mining;
- harness candidate format;
- optimizer sandbox;
- hidden partitions;
- multi-fidelity runner;
- Pareto archive;
- causal ablations;
- signed promotion;
- canary/rollback;
- repair memory;
- model/harness co-evolution experiments.

### Exit gate

- candidate generated from real failure;
- prediction recorded before tests;
- improvement transfers across held-out tasks/models;
- security/chaos pass;
- canary improves target metrics;
- induced regression triggers automatic rollback.

## Phase 12 — Ecosystem and dominance

### Goal

Become the trusted default substrate and prove leadership.

### Work

- open-source local runtime/TCB/protocol/evals;
- self-hosting;
- signed marketplace;
- enterprise policy packs;
- remote fleet and data residency;
- public system cards;
- external benchmark reproductions;
- third-party conformance program;
- ongoing competitor adapters.

### Exit gate

- objective dominance gate in `evals.md`;
- independent reproduction;
- meaningful ecosystem adoption;
- no critical security/durability exception;
- managed service adds value without making open local use second-class.

## 3. Parallel workstreams

Some work can run in parallel after Phase 0:

- product design system and client prototyping;
- eval task creation;
- model-profile research;
- microVM/connector prototypes;
- code-intelligence indexing;
- standards adapters.

They MUST integrate only through stable phase contracts.

## 4. Recommended program structure

Even with cost unconstrained, keep ownership explicit:

- Runtime Protocol and Domain;
- Durable Workflow and Storage;
- Trusted Effects, Identity and Connectors;
- Sandbox/Worker Fleet;
- Context/Repository Intelligence;
- ACI and Verification;
- Models/Orchestration;
- Clients and Operator Experience;
- Computer Use;
- Evaluation and Evolution;
- Security/Red Team;
- Release/Infrastructure.

Each team owns conformance and evals, not only implementation.

## 5. First concrete pull-request sequence

1. CI branch and required-check correction.
2. Generated current system card and support matrix.
3. Component maturity registry (`fixture|stub|experimental|preview|production`).
4. Adapter registry rejects `lastVerified: null` for production.
5. Container effective-enforcement report correction.
6. Secure-mode rejection of degraded macOS/Windows profiles.
7. Durable-state ADR and schema for task/effect/auth.
8. ARP v2 ID/event skeleton and codegen.
9. Embedded durable task store with outbox/inbox.
10. Effect Ledger vertical slice: one local patch and one fixture external connector.
11. Authorization-instance consumption tied to effect.
12. Fault-injection tests for the vertical slice.
13. Secret broker fixture replaced in the slice by opaque connector grant.
14. One CLI and desktop view migrated to the slice.
15. Signed evaluation artifact included in release decision.

## 6. Kill criteria

Stop or redesign a subsystem when:

- it cannot beat the minimal mode on its target cohort;
- it adds authority paths outside the kernel;
- it cannot be made resumable;
- it requires raw credentials in model/runtime context;
- it depends on unobservable model self-report;
- it cannot be independently verified;
- it materially increases review debt without outcome gain;
- it creates permanent upstream coupling without demonstrated value.

## 7. Final sequencing rule

Do not optimize the agent’s intelligence before the system can tell the truth about what happened. Durability, authority, effect semantics and evidence come first; advanced autonomy becomes an advantage only after those foundations are real.

# Deep Research: What It Would Really Take to Build the Best Agent Harness

## 1. Research question

The question is not “what features should another coding agent have?” It is:

> What system architecture, product design, security model, evaluation discipline, and improvement loop would create a harness that is demonstrably better than every serious current alternative across software engineering, coding, computer use, long-horizon autonomy, reliability, speed, cost, security, extensibility, and operator experience?

The answer is necessarily a **system**, not a prompt and not a model wrapper.

## 2. Evidence method

The investigation used fifteen workstreams:

1. Terminus specification, repository, implementation, CI, release and security evidence.
2. OpenAI Codex runtime and clients.
3. Anthropic Claude Code runtime, Agent SDK, subagents, hooks, sandbox and generated orchestration.
4. Open-source coding harnesses: Pi/Oh My Pi, OpenCode, Aider, OpenHands, SWE-agent, mini-SWE-agent, Goose, Cline and Roo.
5. Production internal systems: Stripe Minions, Ramp Inspect, Shopify River/Aquifer, Cursor background agents, GitHub Copilot coding agent, Kiro, Factory Droid, Devin and Amp.
6. NVIDIA AVO, NemoClaw and OpenShell.
7. Durable execution, event sourcing, semantic transactions, idempotency and recovery.
8. Prompt injection, tool poisoning, MCP/skill compromise, credential isolation and computer-use security.
9. Context retrieval, repository graphs, memory, cache behavior and long-horizon state.
10. Human oversight, review burden, operator trust and multiplayer UX.
11. Multi-agent coordination, isolation, scheduling and merge behavior.
12. ACP, MCP, A2A, AG-UI/A2UI and ATIF interoperability.
13. Harness and coding-agent evaluation, contamination, hidden tests and statistical design.
14. Automated harness optimization and trace-driven improvement.
15. Workflow compilation, typed IR, temporal policy and formal verification.

Evidence was classified as:

- **Confirmed:** official documentation, source code, standards or primary research directly supports the claim.
- **Strong inference:** multiple independent high-signal sources support the conclusion.
- **Weak inference:** plausible from demos, public behavior or incomplete evidence.
- **Unknown:** closed implementation or no credible evidence.

Closed systems are not assigned certainty they have not earned.

## 3. What “harness” actually includes

A complete harness includes:

- intent capture and task contracts;
- context discovery and repository intelligence;
- prompting, model protocol and cache layout;
- model selection and reasoning policy;
- tool schema and agent–computer interface;
- filesystem, process, network, secret and external-effect enforcement;
- editing, patching, code intelligence, LSP and debugger integration;
- browser and desktop control;
- planning and workflow execution;
- subagents, scheduling, isolation and merge;
- memory and continuity;
- durable sessions, sandboxes and recovery;
- verification, review and evidence;
- approvals, identity, policy and audit;
- observability, replay and intervention;
- clients and operator experience;
- integrations and extension governance;
- evaluation, experimentation and continual improvement.

A system that is exceptional at only the model loop is not the best harness.

## 4. The state of the field

### 4.1 Codex

Codex’s strongest architectural direction is a **stable shared runtime protocol**. Its app-server model exposes typed thread/turn/item primitives, persistence, resume/fork behavior, approvals and generated schemas to multiple clients. Its advantages are tight model integration, cache-aware context, native compaction, capable sandboxing, and a growing shared substrate between CLI and app surfaces.

What to copy:

- one runtime behind every client;
- typed protocol and generated clients;
- first-class continuation/resume/fork semantics;
- native model-aware context and compaction;
- bounded queues and explicit approval events;
- OS-level effect enforcement.

What to beat:

- provider dependence;
- limited organizational/federated agent model;
- incomplete user-visible causal evidence;
- no public proof that its durability semantics cover ambiguous external effects;
- client/product choices optimized around OpenAI’s stack rather than a universal runtime.

### 4.2 Claude Code

Claude Code’s strongest move is **dynamically generated orchestration**. Claude can write and execute task-specific coordination programs, use isolated subagents, checkpoints, permission modes, hooks, skills and remote control. This can keep large orchestration state outside the primary model context.

What to copy:

- skills and progressive disclosure;
- scoped subagents;
- generated task-specific workflows;
- checkpoints and worktrees;
- strong terminal UX and model-native ergonomics;
- hooks as automation inputs.

What to beat:

- generated scripts must not become an ungoverned authority path;
- hooks and permission prompts are not a security TCB;
- provenance, temporal effects, replay and evidence need stronger semantics;
- organizational coordination needs a durable task system rather than transcript-centric delegation.

### 4.3 OpenCode

OpenCode has made shared client/server architecture table stakes: a headless server, OpenAPI, SDKs, SSE events, ACP integration and shared TUI/web/desktop foundations. Its provider breadth and source availability make it a useful bootstrap substrate.

What to copy:

- headless server and generated SDK;
- provider abstraction;
- local/remote client symmetry;
- extensibility and ACP;
- existing sessions, LSP and MCP plumbing.

What to beat:

- ambient-authority extensions;
- permissions that are not a host security boundary;
- lowest-common-denominator provider abstractions;
- insufficiently rich effect, evidence and trust semantics.

### 4.4 Pi and Oh My Pi

Minimal Pi is valuable because it proves that understandable loops remain competitive. Oh My Pi has become a much more serious systems benchmark: hash-anchored edits, LSP/DAP, persistent code kernels, browser control, memory, multiple compaction strategies, typed isolated subagents and advisor agents.

What to copy:

- comprehensible primitives;
- anchored edits;
- code intelligence and debugger feedback;
- live code kernels;
- isolated workers;
- aggressive interface experimentation.

What to beat:

- “all tools available” does not scale;
- always-on advisors can increase cost and coordination noise;
- host authority and trust boundaries need kernel enforcement;
- rich primitives require evidence-backed activation policies.

### 4.5 Aider

Aider remains a reference for repository maps, graph-based relevance, model-specific edit formats, architect/editor separation, lint/test loops and Git ergonomics.

Its enduring lesson is that **the edit interface and repository projection are model-specific performance variables**. A universal patch format is not automatically optimal.

### 4.6 OpenHands

OpenHands is especially useful for event-oriented architecture, typed action/observation flows, local-to-remote workspace continuity and separation between agent logic and execution environment.

Its lesson is that environment state and conversation state must be distinct but correlated.

### 4.7 Production internal systems

Public engineering reports from Stripe, Ramp, Shopify, Cursor and others converge on the same pattern:

- prewarm real developer environments;
- separate durable conversation state, workflow state and machine state;
- mix deterministic and agentic workflow nodes;
- use short restartable workflows rather than one immortal process;
- create verifiable artifacts;
- learn from production failures;
- make profiles/configuration data rather than hard-coded branches.

Cursor publicly described an early cloud architecture with poor reliability before moving toward shorter Temporal workflows, decoupled machine/conversation/loop state and retry-aware append-only streaming. Stripe’s Minions use deterministic and agentic blueprint nodes with devboxes and controlled retries. Ramp emphasizes full environments, snapshots and visual verification. Shopify’s River/Aquifer work emphasizes durable sessions, append-only data and learning from production traces.

The convergence is stronger evidence than any single vendor claim.

### 4.8 NVIDIA AVO: correction and lesson

The linked NVIDIA post on August 21, 2026 refers to **AVO—Agentic Variation Operators**, not a conventional coding harness and not NOOA. AVO used a main agent with persistent memory and an independent stagnation supervisor to run a seven-day optimization process. NVIDIA reported 100% on the public ARC-AGI-3 set, while explicitly noting that it was a self-run public-set result rather than a controlled harness ablation.

The useful signal is architectural:

- long-horizon systems need a supervisor that detects stagnation independently of the main agent;
- memory should preserve experiments, outcomes and search frontiers;
- autonomous search benefits from variation operators and explicit exploration policy;
- a dramatic task result is not proof that one harness beats another without controlled model and budget comparisons.

### 4.9 Kiro, Cline and cross-surface products

Kiro and Cline reinforce that a shared runtime behind IDE, CLI, web/mobile and SDK surfaces is no longer a differentiator by itself. Kiro’s ACP-based architecture, specs, subagents, checkpoints, deferred tools and local/remote symmetry show where the product baseline is moving.

The differentiator must be the **semantics and quality of the runtime**, not merely the number of clients.

## 5. The strongest cross-cutting findings

### 5.1 Better harnesses are not primarily better prompts

Agentic Harness Engineering, Meta-Harness, HarnessCompass, VeRO, HarnessOpt-Bench, HARNESSFIX, Harness-R1, Co-Harness and HarnessX all point toward the harness as an optimizable program. Reported gains frequently come from tools, middleware, context, memory, workflow and feedback—not from longer system prompts.

Consequence: Terminus needs a sealed evolution laboratory, not a prompt playground.

### 5.2 Model × harness interaction is real

A harness that is optimal for one model may regress another. Native harnesses are not consistently superior in every controlled setting. Evaluation must be factorial:

`model × harness × profile × reasoning effort × task × seed × environment`.

Consequence: model neutrality must permit deep model specialization.

### 5.3 Context is a compiled product

Long transcripts are not state. A strong harness maintains:

- immutable evidence;
- an executable world model;
- repository views;
- episodic, semantic and procedural memory;
- prompt projections.

Prompt context is a disposable, provider-specific projection with a manifest—not the database.

### 5.4 Pass by reference beats repeated text stuffing

Large artifacts, logs, code graphs, browser states and histories should live in typed stores. Models receive versioned handles and bounded views, with authority and provenance attached. This reduces context pressure and makes reuse, cache, verification and access control tractable.

### 5.5 Checkpoints are insufficient for external effects

A crash after sending an API request but before recording success creates an “unknown whether it happened” state. Retrying may duplicate a payment, message, deployment or merge.

The runtime must model semantic transactions and verification-before-retry. Boolean success/failure is not enough.

### 5.6 Generated orchestration needs compilation

Claude-style generated scripts are powerful, but arbitrary Python/JavaScript must not own privileged traversal. The superior pattern is:

1. model drafts a workflow or edits a typed workflow source;
2. compiler produces Workflow IR;
3. static validators check types, reachability, authority, taint, temporal safety, compensation and budgets;
4. deterministic controller owns traversal;
5. models fill bounded judgment slots;
6. candidate state is not authoritative until verified and admitted.

### 5.7 Security requires physical trust separation

Prompt injection is not solved by a label saying “untrusted.” The privileged planner should not receive raw malicious bytes when it does not need them. Quarantined perception workers extract typed facts; sensitive actions require intent-action necessity proofs and are enforced below the model.

### 5.8 Secrets should not be model-readable values

A production secret system should issue a scoped operation capability or inject credentials at a trusted L7 broker. Returning raw secret bytes to general runtime code or environment variables creates unnecessary exposure.

### 5.9 Multi-agent is a scheduling problem, not a feature toggle

Default swarms are often worse. Spawn another agent only when expected value is positive:

`information gain + specialization + parallel speedup - token cost - coordination cost - conflict risk - review cost`.

Writes require isolated workspaces and explicit admission.

### 5.10 UX is an attention-allocation system

Users do not need every token or action. They need:

- mission and acceptance status;
- editable plan;
- current world state;
- risk/effect queue;
- claim-to-evidence graph;
- exact diff/artifact view;
- fleet and budget;
- intervention and causal replay.

The product should ask only questions whose answers materially alter outcome, authority or risk.

### 5.11 Verification must be independent

The actor’s self-report is not evidence. Verification should use independent deterministic checks and, where helpful, clean-context reviewers with no inherited untrusted authority. Completion is a set of admitted claims, not an agent saying “done.”

### 5.12 Product truth is part of security

A system that labels a stub as “enforced” creates operational risk. Every capability claim needs:

- a support declaration;
- a conformance test;
- current evidence;
- environment identity;
- expiry;
- and a UI-visible effective status.

## 6. Why one universal mode cannot be best at everything

Autonomy, safety, latency, cost and interactivity conflict. The product can still dominate every dimension by exposing a **dominance envelope** through policy profiles that share one runtime:

- **Interactive:** low latency, user-steerable, minimal ceremony.
- **Autonomous:** durable long-horizon execution with bounded check-ins.
- **High Assurance:** strict evidence, independent review, stronger isolation.
- **Review:** read-only or suggestion-only, adversarial verification.
- **Research:** broad retrieval, experiments, notebooks and provenance.
- **Incident:** time-sensitive diagnosis with elevated observability and controlled authority.
- **Offline/Local:** local models and local execution with no managed dependency.
- **Fleet:** many tasks and agents with quotas, scheduling and organizational policy.

These are not separate products. They are compiled policy bundles over the same semantics.

## 7. What it would take to be objectively better

### 7.1 Capability

The system must match or exceed the best current system at:

- repository understanding;
- exact editing;
- terminal, browser, desktop and cloud operation;
- long-horizon task decomposition;
- subagents and specialist workflows;
- local and remote environments;
- model/provider breadth;
- cross-surface control.

### 7.2 Reliability

It must add properties competitors do not consistently expose:

- resumable tasks across process and machine failure;
- no duplicate or lost external effects;
- explicit uncertain states;
- deterministic workflow traversal;
- evidence-backed completion;
- clean rollback and compensation;
- formal conformance tests for resume semantics.

### 7.3 Security

It must make the model untrusted by construction:

- no ambient authority;
- no raw credentials in model context;
- untrusted-content separation;
- sequence-level policy;
- capability-bound resources;
- signed and pinned extensions;
- controlled egress;
- system-call/VM/container isolation appropriate to risk;
- independent admission of changes and effects.

### 7.4 Intelligence

It must make the whole system smarter than a single loop:

- context compiler and world model;
- repository graph and code intelligence;
- stage-aware model router;
- workflow compiler;
- expected-value orchestration;
- stagnation supervisor;
- trace-driven evolution.

### 7.5 Product experience

It must feel better every day:

- instant local interaction;
- seamless escalation to remote compute;
- clear progress without noisy transcripts;
- powerful keyboard/CLI workflows;
- exceptional native app and IDE integration;
- mobile supervision that is safe rather than gimmicky;
- understandable permissions and evidence;
- one task identity across every surface.

### 7.6 Empirical proof

It must publish:

- pinned system cards;
- model × harness controlled comparisons;
- private rotating tasks;
- repeated seeds and confidence intervals;
- cost, latency and human-attention accounting;
- security and chaos results;
- regressions and known limitations;
- reproducible public subsets.

Without this, “best” is marketing.

## 8. Defensible advantage

Features will be copied. The defensible system is the flywheel:

1. high-quality structured traces;
2. exact failure attribution;
3. private and public evals;
4. harness candidates generated from real failures;
5. multi-fidelity held-out testing;
6. signed promotion and canarying;
7. better model profiles and workflows;
8. better daily product, producing better traces.

The moat is compounded operational knowledge encoded as verified runtime improvements.

## 9. Final synthesis

The best harness is a combination of:

- Codex’s shared typed runtime;
- Claude Code’s dynamic orchestration and skills;
- OpenCode’s open client/server ecosystem;
- Oh My Pi’s rich ACI experiments;
- Aider’s model-specific repository/edit strategy;
- OpenHands’ event-oriented workspace abstraction;
- production systems’ durable distributed workflows and prewarmed environments;
- NVIDIA AVO’s independent stagnation supervision;
- formal workflow compilation;
- semantic transaction research;
- prompt-injection-resistant trust separation;
- and automated, held-out-tested harness evolution.

But simply combining features would produce an incoherent monster. The unifying idea is:

> **Models propose and judge. Typed programs coordinate. A trusted kernel authorizes and performs effects. Independent verifiers admit claims. Durable state makes every step resumable. The operator controls intent, authority and attention.**

# Terminus North Star: Building the Best Agent Harness

**Research cut:** August 21, 2026  
**Repository audited:** `ezzy1630/Terminus`  
**Branch:** `codex/release-blocker-closure`  
**HEAD reviewed:** `64d385c7b9efedee96b229432937622aa1aba720`  
**Research method:** 470 Exa search results across 15 workstreams, direct retrieval of primary sources, full review of the existing `SPEC.md`, complete repository-tree review, and architecture-level inspection of the implementation paths that determine security, durability, execution, adapters, evaluation, and release truth.

## Verdict

The winning product is **not a larger agent loop**. It is an **Agent Operating System**:

- one durable runtime used by CLI/TUI, native desktop, IDE, web, mobile supervision, and headless APIs;
- a model-neutral canonical core with deeply model-native execution profiles;
- an adaptive cognitive plane above a deterministic authority and effects plane;
- proof-carrying tasks, typed workflows, transactional effects, explicit uncertainty, and independent verification;
- persistent organizational operators and local workers without a company-wide root agent;
- a context and state operating system that passes typed, versioned references instead of repeatedly stuffing raw text into prompts;
- a secure computer-use and software-engineering substrate;
- an operator cockpit designed around missions, evidence, risk, and intervention—not generic chat;
- and a sealed evolution laboratory that improves the harness from traces without silently regressing it.

A product with this architecture can be designed to dominate Codex, Claude Code, Pi/Oh My Pi, OpenCode, Aider, OpenHands, Cursor, Devin, Kiro, Copilot coding agent, and internal systems such as Stripe Minions or NVIDIA AVO. **Objective superiority, however, is earned only when the evaluation program in `evals.md` demonstrates it under controlled model × harness × effort comparisons.**

## The twelve architectural leaps that matter

1. **Durable runtime, not durable-looking objects.** Conversation, task, workflow, machine, sandbox, approval, and effect state survive process and machine failure.
2. **Semantic transactions for external effects.** Every action has proposed, authorized, prepared, dispatched, observed, validated, committed, compensated, and uncertain states.
3. **Trust-separated cognition.** Untrusted repository/web/tool content is inspected outside the privileged planning context.
4. **A workflow and skill compiler.** Prose procedures compile into typed, statically checked workflow IR; code owns mechanism and models own bounded judgment slots.
5. **An object-capability data plane.** Agents receive typed handles with version, authority, and provenance rather than uncontrolled blobs and ambient host access.
6. **Proof-carrying completion.** Claims are linked to exact evidence, environment identity, verifier results, and unresolved uncertainty.
7. **Capability-maximal model neutrality.** One canonical runtime, with provider-specific context layouts, tool dialects, compaction, cache strategy, continuation, and reasoning policies.
8. **Expected-value orchestration.** Subagents are spawned only when predicted information gain, specialization, or parallelism exceeds coordination and merge cost.
9. **An operator cockpit.** The primary interface is a controllable system map and evidence graph, not a transcript.
10. **Computer use as a governed effect system.** Browser and desktop actions use the same intent, authority, transaction, verification, and replay semantics as code changes.
11. **A sealed evolution lab.** Harness changes are trace-grounded, held-out-tested, causally attributable, signed, canaried, and automatically reversible.
12. **Evidence-backed product truth.** No support, security, durability, benchmark, or release claim exists without current machine-verifiable evidence.

## Recommended strategic decisions

### Model architecture

Use a **capability-maximal model-neutral core**:

- canonical task, state, effect, evidence, artifact, workflow, and capability protocols are provider-independent;
- model profiles are first-class and may deeply specialize prompts, tool schemas, context ordering, cache prefixes, continuation, compaction, reasoning effort, and error recovery;
- stage-aware routing selects the model/profile pair for each node;
- no lowest-common-denominator abstraction is allowed to hide a model’s stronger native abilities.

This preserves leverage across GPT, Claude, Gemini, open-weight and future models without sacrificing vertical optimization.

### Product and business model

Use an **open trusted base / open-core strategy**.

Open:

- the local runtime and trusted effect kernel;
- canonical protocol and schemas;
- CLI/TUI, SDKs, self-hosting, extension formats, and workflow compiler;
- sandbox policy definitions and conformance tests;
- the evaluation runner and public benchmark methodology.

Managed:

- remote execution fleet and prewarmed environments;
- collaboration, enterprise governance, identity, policy distribution, and audit retention;
- hosted model routing and inference optimization;
- signed workflow/skill marketplace and trust service;
- private evaluation intelligence and organization-specific improvement loops.

The moat should be the evaluation/data flywheel, model profiles, operator experience, verified workflow library, secure fleet, and organizational intelligence—not a hidden loop that users cannot trust.

### Interoperability

Own a richer internal protocol and provide strict adapters:

- ACP for editors and clients;
- MCP for tools/resources;
- A2A for independent agent-to-agent exchange;
- AG-UI/A2UI for frontend state;
- ATIF for trace interchange.

External standards are boundaries, not the internal source of truth.

## Research package

| File | Purpose |
|---|---|
| [`research.md`](research.md) | Landscape, causal findings, competitor synthesis, and what it actually takes to win |
| [`scorecard.md`](scorecard.md) | Public-evidence comparison framework and objective dominance criteria |
| [`architecture.md`](architecture.md) | North-star Agent OS architecture |
| [`SPEC.md`](SPEC.md) | Normative implementation specification for Terminus 2 |
| [`evals.md`](evals.md) | Controlled benchmark, security, chaos, UX, and release-evaluation program |
| [`roadmap.md`](roadmap.md) | Concrete staged evolution of the current Terminus repository |
| [`terminus-audit.md`](terminus-audit.md) | Evidence-based audit of the current branch and implementation |
| [`implementation-reconciliation.md`](implementation-reconciliation.md) | August 23 mapping from all twelve research leaps to current implementation evidence and remaining gates |
| [`sources.md`](sources.md) | Curated primary-source map and research methodology |
| [`manifest.json`](manifest.json) | File hashes and research metadata |

## Current implementation reconciliation

The documents above preserve the August 21 research cut. The companion
[`implementation-reconciliation.md`](implementation-reconciliation.md) records
the August 23 standalone-runtime and desktop implementation, the checks run on
the packaged artifact, and the north-star gates that remain unproven. Read it
with `maturity.yaml` and the repository release gates before making a current
product or readiness claim.

## Important scope note

The repository review covered the complete tree, the full existing specification, release configuration, and the architecture-critical implementations that define the product’s real properties. It was not a claim that every line of every generated client, test fixture, lockfile, or UI component was manually line-reviewed. No local build or test execution was possible in this environment; current implementation findings distinguish source observation from runtime verification.

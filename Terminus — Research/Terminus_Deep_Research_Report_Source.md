# Terminus: From Ambitious Agent OS to Benchmark-Leading Harness

**Commit-pinned architecture, implementation, competitor, and execution audit**  
**Repository:** `ezzy1630/Terminus`  
**Audited revision:** `0cd373cef6d568df4891c84032d43b49f08e076e`  
**Audit date:** August 24, 2026  
**Prepared for:** Ezzy  

---

## Executive verdict

Terminus has the right *kind* of ambition. It is not trying to be another thin chat wrapper; it is attempting to become a provider-neutral agent operating system with a trusted Rust effects plane, typed task and effect contracts, explicit context compilation, evidence-bound completion, multiple clients, external-harness adapters, and an evaluation/evolution plane. That direction is more defensible than cloning any single current coding agent.

But the repository is not yet a competitive coding harness, much less the objectively best one. The current maturity inventory records **zero production components**, with most systems classified as experimental, preview, stub, or fixture. The default quickstart intentionally fails closed before a useful model turn when no provider transport is configured. Fresh gateway model discovery is blocked by an unimplemented catalogue fetch. Several high-value systems—tokenization, compaction, routing, expected-value delegation, and durability—are sophisticated contracts backed by coarse heuristics or in-memory reference implementations. The external harness adapters are honest stubs. The eval plane is broad, but it does not yet provide live, reproducible evidence that Terminus beats a strong baseline under the same model, task, environment, budget, and seed.

The central strategic recommendation is:

> **Stop expanding the architecture surface. Build and measure one complete native coding loop.**

Terminus should become a **profile-driven runtime**, not one uniformly heavy harness:

1. **Native Performance profile:** a deliberately thin Pi/mini-SWE-like coding loop with exact provider-native transcripts, compact tools, stable-prefix caching, fast retrieval, low overhead, and independent verification.
2. **Governed Local profile:** the same loop behind the Rust broker, capabilities, policy, secrets, approvals, and effect receipts.
3. **Durable Cloud profile:** persistent or snapshotted environments, durable event/effect state, async execution, organization knowledge, and multi-surface supervision.
4. **Computer Use profile:** DOM/accessibility/CDP-first browser control, typed desktop actions, visual fallback, replayable observations, and the same effect/verification model.

The model-facing surface should remain thin in every profile. The richer operating-system machinery belongs behind the loop and should activate only when its measured expected value exceeds its token, latency, coordination, and failure cost.

### What must happen next

The first milestone is not another package, schema, client, adapter declaration, or speculative routing policy. It is a single end-to-end path that can:

- start from a clean repository and admitted model profile;
- render a correct OpenAI Responses or Anthropic Messages request;
- stream and persist provider events;
- execute compact coding tools exclusively through the trusted broker;
- edit in a versioned workspace;
- run targeted and acceptance-level verification;
- bind claims to immutable evidence, repository revision, and environment identity;
- survive cancellation, restart, ambiguous network outcomes, and duplicate requests;
- render the same authoritative state in CLI, TUI, desktop, and API clients;
- and produce a benchmark artifact that can be replayed and independently graded.

Until that spine exists and wins controlled evaluations, almost every broader feature is premature.

---

## 1. What “objectively best” can mean

There is no universal scalar called “best harness” unless the objective function and hard constraints are declared. A harness can optimize benchmark resolution rate by spending more tokens, reduce cost by accepting lower pass rate, increase autonomy by weakening controls, or improve UX while adding runtime overhead. Terminus should therefore claim superiority only through **declared Pareto dominance** and a public scorecard.

### 1.1 Hard gates

A candidate build is ineligible regardless of benchmark score if it fails any of these:

- provider transcript conformance;
- effect non-bypassability;
- workspace and secret isolation;
- idempotent recovery after ambiguous submission or restart;
- independent completion verification;
- benchmark environment and grader reproducibility;
- release provenance and artifact integrity.

### 1.2 Primary objective

The most useful north-star metric is:

**Verified successful tasks per dollar-hour**, with the denominator including model cost, compute cost, wall-clock time, and weighted human attention.

That prevents a misleading win produced by spending unlimited tokens, spawning unnecessary agents, or asking the user to repeatedly repair the environment.

### 1.3 Required secondary metrics

Terminus should report a vector, not hide everything inside one score:

- verified task success and partial-credit quality;
- first-pass success and recovery success;
- cost per verified success;
- wall-clock and active-compute time;
- fresh input, cached input, output, and reasoning tokens;
- stable-prefix cache hit rate and cache invalidation waste;
- tool-schema token overhead;
- unnecessary context rate and omitted-required-evidence rate;
- tool-call correctness, edit application rate, and revert rate;
- verification precision and false-completion rate;
- duplicate/ambiguous effect rate;
- security escape and secret-exposure rate;
- human interventions, decision latency, and supervision minutes;
- resume fidelity after crash, compaction, handoff, or device change;
- UX task completion and subjective operator confidence.

### 1.4 Comparison modes

Every public result should identify one of two modes:

- **Locked-harness comparison:** same model, effort, task, environment, budget, and tool privileges; only the harness changes.
- **Native-harness comparison:** each product runs in its best supported configuration; this measures the product, not isolated harness quality.

Both matter. The first reveals harness contribution. The second reveals what users can actually buy or run.

---

## 2. Research and audit method

This report combines:

- a commit-pinned static audit of the repository tree, generated inventory, maturity matrix, current research documents, provider renderers, control-service hot path, Rust kernel, task/effect persistence, context compiler, ACI, router, orchestration, verification, clients, adapters, and eval fixtures;
- primary-source research on Pi, Oh My Pi, Hermes Agent, Prime Agent, Codex, Claude Code, Cursor, Devin, Factory, Amp, GitHub Copilot, Google Antigravity/Gemini CLI, OpenHands, mini-SWE-agent, KIRA, Harbor, Terminal-Bench 2.0, SWE-bench Verified, BrowserGym, WorkArena, and WebArena-Verified;
- synthesis against the prior Terminus research, audit, roadmap, scorecard, architecture, eval design, and August 24 implementation reconciliation already present in the repository.

### 2.1 Important limitations

This is a **static, commit-pinned audit**, not a live benchmark certification. I could not obtain a local checkout in the execution environment, so I did not rerun the repository’s Rust, TypeScript, Python, desktop, integration, or live-provider test suites. Where the repository reports green CI or test counts, this report identifies those as repository evidence rather than independently reproduced results.

I also did not supply live provider credentials, run a 24-hour soak, execute a signed release, exercise a real external-harness adapter, or submit Terminus to a public benchmark. Therefore:

- no benchmark-leadership claim is made;
- no live security certification is made;
- no current numerical score should be interpreted as a production readiness rating;
- competitor performance claims are treated as vendor claims unless backed by an official benchmark artifact.

---

## 3. Competitive anatomy: what the strongest harnesses actually do well

The most important finding across the market is that there is no single winning architecture. Strong systems specialize in different layers. Terminus should copy mechanisms, not brands.

### 3.1 Pi: minimal, legible, extensible

Pi’s strength is the smallness and clarity of the core loop. Its repository separates a unified multi-provider API, agent runtime/state, coding CLI, and TUI. The coding agent is intentionally extensible through skills, templates, themes, packages, and extensions rather than forcing a large orchestration framework into every turn. Pi also states its security boundary honestly: it runs with the launching process’s permissions unless separately containerized or sandboxed.

**What Terminus should copy**

- an auditable hot path small enough for one engineer to understand;
- a stable default tool set;
- provider-neutral types without flattening provider-native semantics;
- fast interactive TUI ergonomics;
- extension points outside the trusted core;
- honest statements about the boundary actually enforced.

**What Terminus should improve**

- enforce permissions, egress, workspace, and secrets below extensions;
- require capability leases and effect receipts;
- independently verify completion;
- preserve Pi-like simplicity at the model boundary even when the backend is richer.

### 3.2 Oh My Pi: an aggressively optimized coding ACI

Oh My Pi demonstrates the value of optimizing the agent-computer interface specifically for code: hash-anchored edits, LSP feedback, debugger integration, persistent Python/Bun execution, browser tools, progressive resource disclosure, and subagents. Its appeal is not merely more tools; it tries to reduce edit ambiguity and keep structured execution state available without repeatedly serializing it through the model.

**What Terminus should copy**

- hashline/hash-anchored editing;
- immediate diagnostics after writes;
- persistent, typed REPL state for data-heavy or investigative tasks;
- model-readable resource handles instead of dumping large outputs;
- tool-output continuation and search over artifacts;
- coding-focused tool schemas tested against real models.

**What Terminus should avoid**

- making every advanced tool visible by default;
- treating tool richness as proof of harness quality;
- allowing extension code to become a second, less-governed effects plane.

### 3.3 mini-SWE-agent: the power of a tiny shell loop

mini-SWE-agent is an important control condition. It shows that a small agent around a shell can be highly competitive because the model already understands terminal interaction and because the harness introduces little schema overhead or orchestration noise.

**Lesson for Terminus:** every abstraction must beat a minimal shell baseline in controlled ablations. If the Context Compiler, typed ACI, router, subagents, or verifier reduce success or increase cost without a compensating safety/reliability gain, they should be disabled in the performance profile.

### 3.4 Hermes Agent: continuity, learning, and automation

Hermes emphasizes a closed learning loop: curated memory, skill creation and refinement, searchable prior sessions, user modeling, cross-platform messaging, scheduled automations, isolated subagents, and Python scripts that invoke tools through RPC. Its strongest product insight is continuity—the agent grows across sessions and can be reached where the user already works.

**What Terminus should copy**

- explicit cross-session memory with provenance and retrieval triggers;
- skills distilled from successful traces, but reviewable and reversible;
- one gateway across CLI, chat, mobile, and automation surfaces;
- scheduled durable work;
- programmatic tool pipelines that avoid repeated model round trips.

**What Terminus should improve**

- separate observed fact, user preference, derived hypothesis, and temporary task state;
- require evidence and expiry for memory;
- evaluate every learned skill on held-out tasks before promotion;
- make all self-modification visible, diffable, attributable, and roll-backable.

### 3.5 Prime Agent: continual harness state and programmatic context

Prime Agent’s most original idea is treating the harness itself as editable state: prompts, durable memory, skills, subagent specifications, and refinements can change over time, with local/global scope and rollback history. Its RLM-style persistent execution environment also treats code as a context-management primitive: inspect, transform, filter, and call tools programmatically rather than serializing every intermediate into the language-model transcript.

**What Terminus should copy**

- harness state as a versioned artifact;
- local versus global refinement scope;
- refinement history and rollback;
- persistent programmable workspaces for data/research tasks;
- programmatic subagent composition.

**What Terminus must add**

- a sealed promotion pipeline;
- user-visible proposed diffs before durable refinement;
- replay and held-out evaluation of every change;
- signed provenance for promoted policies, prompts, skills, and routing rules;
- automatic rollback on regression.

### 3.6 Codex: one harness, many surfaces

Codex’s key architectural advantage is not just the model. OpenAI documents that web, CLI, IDE, and app surfaces share the same underlying harness, exposed through a bidirectional App Server protocol with threads, turns, event notifications, tool items, and approval requests. The app adds isolated worktrees, multi-agent supervision, skills, automations, and movement between local and cloud execution.

**What Terminus should copy**

- one authoritative runtime and event protocol across all clients;
- a thread/turn/item model suited to streaming and resumption;
- worktree isolation as the default for concurrent writers;
- model-native prompt/cache design;
- cloud/local mobility without changing task identity;
- app-level multi-agent supervision rather than terminal multiplexing.

**What Terminus should improve**

- portable provider neutrality where it does not degrade native behavior;
- explicit proof obligations and verifier independence;
- auditable transactional effects and durable ambiguity handling;
- open benchmark and replay artifacts.

### 3.7 Claude Code: secure autonomy through real boundaries

Claude Code’s strongest lesson is that autonomy should come from containment rather than repeated prompts. Anthropic documents OS-level filesystem and network isolation using primitives such as bubblewrap and macOS Seatbelt, including subprocess coverage. Its broader containment model distinguishes environment boundaries from probabilistic model controls and emphasizes that credentials kept outside the sandbox cannot be exfiltrated from inside it. Claude Code subagents support scoped tools, denied tools, model selection, permission modes, turn limits, skills, background execution, and worktree isolation.

**What Terminus should copy**

- trust-before-parse for repository configuration;
- OS-enforced filesystem and egress policy covering children;
- credentials held outside the agent sandbox;
- scoped subagent tools, models, memory, and worktrees;
- hooks at security-relevant lifecycle points;
- read-only scouts and reviewers by default.

**What Terminus should improve**

- capability leases checked at proposal and commit;
- durable receipts and compensations for external effects;
- a single non-bypassable broker across native tools, plugins, MCP, and external harnesses;
- public conformance and failure-injection evidence.

### 3.8 Cursor: prepared environments and distributed supervision

Cursor Cloud Agents emphasize isolated virtual machines, parallel execution, multi-repository work, desktop/browser control, MCP access, and initiation from desktop, web, mobile, Slack, source-control comments, Linear, or API. Cursor explicitly frames environment setup as essential: an agent that cannot build, test, query services, or reach required APIs cannot close the loop.

**What Terminus should copy**

- prepared and snapshotted environments;
- multi-repo workspace identity;
- artifact-rich supervision from any surface;
- browser/desktop control as part of software delivery, not a separate toy;
- remote desktop and visual evidence for user review.

### 3.9 Devin: environment readiness and organizational workflow

Devin’s environment system is a major product moat. Each session starts from a clean snapshot containing repositories, tools, dependencies, credentials, and project knowledge. Blueprints make setup declarative and reviewable. Knowledge is automatically generated and retrieved by trigger, and the UI exposes which knowledge was accessed. The broader product integrates source control, issue trackers, messaging, scheduled sessions, deployment, and organizational controls.

**What Terminus should copy**

- snapshot-first environment readiness;
- declarative environment blueprints with build verification;
- repo knowledge with trigger-based retrieval and visible provenance;
- organization-level onboarding and policy;
- durable asynchronous tasks and scheduled sessions;
- parent/child coordination where each worker has an isolated environment.

### 3.10 Factory Droids: deferred context and persistent machines

Factory’s Deferred Context Engine makes a precise point: prompt caching reduces billing and recomputation, but irrelevant tool definitions still occupy the model’s working set, increase selection noise, and trigger earlier compression. Factory defers long-tail schemas and reports vendor telemetry of roughly 15% average input-token reduction for MCP-triggered enterprise sessions. Factory also emphasizes persistent machines and organization-wide context.

**What Terminus should copy**

- minimal always-visible tool vocabulary;
- cheap capability cards, full schema only on activation;
- measurement of schema tokens and tool-selection errors;
- persistent prepared machines where that improves task latency;
- organization-wide context with explicit scope.

**Required caveat:** vendor token-reduction figures are useful hypotheses, not transferable proof. Terminus must reproduce the effect on its own tasks and models.

### 3.11 Amp: focused handoffs and complementary agents

Amp’s handoff mechanism starts a fresh thread with a generated prompt and relevant files, reviewable before sending. This is often safer than repeatedly compressing a long thread into stacked summaries. Amp also uses complementary read-only agents such as an Oracle and has rebuilt its product around a durable, distributed loop across CLI, web, desktop, and mobile surfaces.

**What Terminus should copy**

- handoff as a first-class context operation;
- user-reviewable handoff bundles;
- complementary read-only reviewer/oracle roles;
- thread search and cross-surface continuity;
- willingness to delete stale architecture rather than preserve compatibility forever.

### 3.12 GitHub Copilot: ecosystem, governance, and lifecycle hooks

GitHub Copilot’s advantage is integration with the software-delivery system. Custom agents can define prompts, tools, and scopes; subagents can keep specialist work out of the main context; hooks observe and control lifecycle events; and GitHub can apply CodeQL, secret scanning, dependency advisories, reviews, Actions, and repository policy around agent output.

**What Terminus should copy**

- capability-specific agents with isolated context;
- complete lifecycle event streams;
- organization-distributed skills and agent profiles;
- security scanning as independent verification;
- native source-control and CI evidence;
- on-demand capability discovery rather than permanent schema injection.

### 3.13 Google Antigravity, Gemini CLI, and Jules: product succession matters

As of May 19, 2026, Google announced the transition from Gemini CLI toward Antigravity CLI for its unified multi-agent platform. The announcement explicitly cites the need for multiple communicating agents and a unified backend; Antigravity 2.0 adds desktop orchestration, dynamic subagents, scheduled tasks, and a lightweight CLI surface. Gemini CLI remains relevant as an open-source implementation reference, particularly for tool expansion, caching, sandboxing, hooks, skills, MCP, and shadow-git checkpointing, but Terminus should compare against the current platform rather than an obsolete product label. Jules remains a useful async GitHub-native product reference.

**What Terminus should copy**

- one server-side harness across desktop, CLI, and SDK;
- dynamic subagents and scheduled execution;
- lightweight clients over persistent managed environments;
- checkpointing and state restoration;
- explicit migration/version strategy as product architecture changes.

### 3.14 OpenHands: composable runtime and sandbox abstraction

OpenHands provides a broad open platform with local, cloud, enterprise, and SDK surfaces, plus sandbox abstractions. Its process sandbox documentation is also useful because it warns when a mode is not a security boundary.

**What Terminus should copy**

- runtime providers behind a stable interface;
- local and remote deployment modes;
- open evaluation and integration ecosystem;
- explicit sandbox-strength labels.

### 3.15 KIRA and Meta-Harness: optimize the harness, but separate evidence from branding

KIRA and recent Terminal-Bench artifacts illustrate the growing importance of harness optimization itself: tool calling, multimodal inputs, execution policy, verification, and bootstrap/refinement can change scores materially even with the same underlying model. These systems also create a naming hazard: KRAFTON’s “Terminus 2” and “Terminus-KIRA” are unrelated to this repository.

**Lesson:** Terminus needs harness-level ablations, reproducible artifacts, and clear identity. It should never infer superiority from a name, a vendor post, or a single model/harness leaderboard entry.

---

## 4. Competitive synthesis: the architecture Terminus should adopt

The market resolves into seven durable principles.

### 4.1 Keep the model-facing loop thin

A large backend is acceptable; a large prompt surface is not. The default turn should expose only the minimal task contract, project instructions, focused evidence, active workspace state, and a compact stable tool set. Every optional tool, skill, subagent, connector, and policy explanation should be deferred until relevant.

### 4.2 Preserve provider-native semantics

Provider neutrality belongs in a semantic intermediate representation, telemetry, policy, and task model. It must not erase provider-native tool-call IDs, caching primitives, reasoning controls, resumable response identifiers, image/document blocks, or streaming events.

### 4.3 Treat environment setup as part of intelligence

A stronger model in a broken environment loses to a weaker model in a prepared one. Terminus needs reproducible local environments, snapshotable cloud environments, dependency caches, service readiness checks, and a `doctor` path that distinguishes code failure from environment failure.

### 4.4 Use containment to buy autonomy

The agent should not ask for approval for routine operations inside a narrow, enforced capability boundary. It should ask when crossing that boundary. Credentials, egress, external effects, and sensitive hosts remain brokered outside the sandbox.

### 4.5 Use multiple agents selectively

Parallelism is not inherently intelligent. Default to one authoritative writer. Spawn read-only scouts, reviewers, or specialists when separability and expected information gain justify the cost. Put parallel writers in isolated worktrees and require explicit synthesis and verification.

### 4.6 Make continuity observable

Memory, project knowledge, checkpointing, handoffs, and learned skills must state where they came from, why they were included, when they expire, and how they changed. Silent refinement is not acceptable.

### 4.7 Make superiority an eval result

Every substantial mechanism must have a feature flag, trace identifier, cost accounting, and ablation cohort. The system must be able to answer: *Did this feature improve verified success enough to justify its tokens, latency, and complexity?*

---

## 5. Terminus repository: current architecture and maturity

The repository is unusually broad for its maturity. Its generated inventory reports approximately:

- a 9,618-line specification;
- 23 Rust crates;
- 33 TypeScript packages;
- four application surfaces;
- seven external-harness adapters;
- two mini-services;
- hundreds of declared tests across Rust, TypeScript, Python, and desktop code;
- dozens of ADRs and runbooks.

The intended architecture is coherent:

- **Clients:** CLI, TUI, desktop, IDE/ACP, API, and eventually web/mobile.
- **Control/cognition:** task runtime, context compiler, model router, workflow/orchestration, ACI, verification, provider renderers, and session state.
- **Trusted execution:** a Rust kernel for policy, capabilities, filesystem, patching, process/jobs, egress, secrets, artifacts, sandboxes, connectors, and remote execution.
- **Durable/evidence plane:** SQLite/event log, content-addressed artifacts, Git revisions, telemetry, replay, and evaluation.

The architecture document correctly insists that models propose and judge while a deterministic authority/effects plane owns irreversible actions. That is the right north star.

### 5.1 Maturity truth

The generated maturity matrix is more important than the package count:

- production: 0;
- preview: 11;
- experimental: 46;
- stub: 9;
- fixture: 5.

The repository itself identifies stub adapters for Claude Code, Codex, and Pi; declaration-only integrations for Oh My Pi, Omnigent, and OpenHands; stub extension and sandbox surfaces; missing live provider conformance; incomplete durable job semantics; incomplete computer-use execution; and missing held-out eval evidence.

### 5.2 What improved since the earlier audit

The August 24 implementation reconciliation shows meaningful progress:

- unsafe standalone architecture was reduced;
- fake provider success paths were removed in favor of fail-closed behavior;
- the desktop is described honestly as experimental;
- the repository has an inventory/maturity ledger;
- security findings were triaged and runtime issues fixed;
- provider gateway and local-command transports are wired in the control service;
- the Rust kernel has substantive capability, isolation, recovery, policy, secret, and non-bypassability tests;
- the architecture is increasingly one system instead of disconnected demos.

The remaining work is therefore not “clean up obvious dishonesty.” It is to close the gap between typed contracts and live, measured behavior.

---

## 6. End-to-end hot-path audit

A benchmark-leading harness needs one hot path that is both small and complete:

`user intent → task contract → context → provider request → streamed model actions → brokered tools/effects → workspace revision → verification → evidence-bound completion → durable events → client rendering`

Terminus currently has most nouns in that sentence, but the path remains too fragile and too distributed.

### 6.1 Control service concentration

The main control-service entrypoint is approximately 419 KB. It imports and coordinates provider execution, task/session state, context compilation, tools, verification, events, and operational APIs. Large files are not automatically bad, but this one makes it difficult to prove which state machine is authoritative, test failures in isolation, or reason about transactions.

**Required change:** split by authoritative responsibility, not by arbitrary helper size:

- `TurnCoordinator`;
- `ProviderSessionService`;
- `ToolEpisodeService`;
- `EffectSettlementService`;
- `VerificationCoordinator`;
- `TaskProjectionService`;
- `EventSubscriptionService`.

Each service should expose a narrow command/event contract, and the transaction boundary should be visible in code.

### 6.2 Default run path is not useful

The control-service README states that the default provider path reaches `PROVIDER_RUNNING` and then blocks with `provider_transport_unavailable` unless a kernel-brokered local provider command or gateway path is configured. Failing closed is correct, but a quickstart that cannot perform a real coding turn is not yet a product quickstart.

**Required change:** ship at least one supported, conformance-tested provider path whose configuration is straightforward and whose model catalogue can be admitted without hand-editing internal records.

### 6.3 One complete turn must become the integration boundary

The first production-grade integration test should not mock the critical path. It should launch:

- a real database;
- the Rust kernel;
- the control service;
- a deterministic fake provider speaking the exact streaming protocol;
- a temporary Git repository;
- real brokered read/search/patch/exec tools;
- a verifier;
- and a client that disconnects and resumes.

It should then prove exact event ordering, idempotency, restart recovery, artifact integrity, revision binding, and final completion.

---

## 7. Provider plane: the highest-priority technical gap

Model quality cannot compensate for malformed transcripts. Provider correctness should be P0.

### 7.1 Current strengths

- provider-neutral capability, usage, cost, cache, and fallback contracts exist;
- OpenAI and Anthropic renderers exist;
- a gateway transport normalizes OpenAI Chat, OpenAI Responses, and Anthropic Messages style streams;
- the gateway asks the Rust kernel for a credential-bound connector grant;
- the local provider command executes as a bounded kernel job rather than raw TypeScript process spawn;
- the default path fails closed rather than fabricating completion.

### 7.2 Current blocking problems

#### Fresh model discovery is impossible

The provider model discovery path requires a gateway and models catalogue, but `fetchModelsDevCatalog()` currently throws unconditionally. The discovery routine calls it before it can admit models. The result is that a fresh configured gateway cannot complete supported discovery through the intended path.

**Fix:** implement a signed or hash-pinned catalogue fetch with explicit cache, expiry, offline snapshot, and admission record. Discovery failure must preserve already-admitted profiles but block unknown ones.

#### No first-class native direct transports

Repository search found no native `api.openai.com` or `api.anthropic.com` implementation in the provider packages. Live execution is routed through the OpenCode gateway abstraction or a configured local provider command. That may be a supported deployment option, but it leaves Terminus unable to independently validate provider behavior and creates an unnecessary dependency for the primary performance path.

**Fix:** implement direct native adapters through the Rust connector/secrets/egress plane:

- OpenAI Responses API;
- Anthropic Messages API;
- one OpenAI-compatible local endpoint;
- later Google/Antigravity-compatible and other providers.

#### Streaming is normalized too late

The gateway kernel client obtains the connector response body and then yields it as a chunk to the TypeScript transport. This weakens true end-to-end streaming, time-to-first-token measurement, mid-stream cancellation, backpressure, and bounded handling of large responses.

**Fix:** make the connector protocol stream frames from the broker to control, persist raw frame artifacts as needed, and propagate cancellation to the socket and provider request.

#### OpenAI request semantics need conformance work

The renderer appears to combine Chat Completions concepts (`messages`) with Responses-style fields and Anthropic-style cache metadata. Tool results are not clearly bound with provider-required call identifiers. Predicted cache use is heuristic.

**Fix:** separate renderers by actual endpoint contract. Preserve:

- response/previous-response IDs;
- call IDs and tool-result IDs;
- native reasoning controls;
- parallel tool-call semantics;
- structured output schema;
- provider cache controls;
- exact usage fields;
- image/document blocks;
- refusal and incomplete-response states.

#### Anthropic tool episodes are flattened

The renderer appears to convert tool results into user text rather than native structured `tool_result` blocks linked to `tool_use_id`. That can degrade multi-turn tool reliability and caching.

**Fix:** create a provider transcript conformance suite with golden fixtures for assistant text, reasoning, tool use, tool result, multiple tools, errors, truncation, cancellation, retries, and continuation.

### 7.3 Provider architecture to build

Use a semantic provider IR, then endpoint-specific renderers:

- `SemanticMessage`: authority, developer, user, assistant, tool call, tool result, artifact reference;
- `ProviderConversationState`: native response ID, cache epoch, transcript hash, model profile version;
- `ProviderRequestPlan`: ordered stable prefix, volatile suffix, tools, output contract, reasoning budget;
- `ProviderEvent`: text delta, reasoning delta/summary, tool call delta, usage, cache, refusal, error, completion;
- `ProviderReceipt`: request hash, transcript hash, model/profile version, provider IDs, usage, finish state.

The semantic IR should be loss-aware: any field that cannot be represented by a target provider must produce an explicit downgrade or reject the route.

---

## 8. Agent-computer interface: make tools smaller and more reliable

Terminus’s ACI has a good conceptual shape: seven always-visible tools, a universal result envelope, progressive disclosure, artifacts, source versions, truncation, diagnostics, side effects, timing, resource use, trace IDs, and policy decisions.

The challenge is model performance.

### 8.1 Problems to fix

- the active tool registry and capability activation are process-local;
- capability discovery uses simple substring scoring;
- the active tool-set cache key uses tool ID/version but not necessarily the definition hash, so an unversioned schema change can evade cache invalidation;
- schemas and result envelopes are richer than a model needs on every call;
- the model must not pay for fields that are primarily for observability or control.

### 8.2 Recommended default coding tool set

Expose a compact semantic set, with provider-specific descriptions tuned by evaluation:

1. `read` — line/range, symbol, diff-aware, artifact continuation;
2. `search` — path/glob/regex/symbol/reference, ranked and bounded;
3. `edit` — hash-anchored replace and structured patch transaction;
4. `shell` — bounded foreground command;
5. `job` — durable/background process and log continuation;
6. `inspect` — diagnostics, Git state, tests, environment, artifacts;
7. `capability` — search/activate deferred tools and skills.

`verify` can be a model-visible convenience, but the authoritative verifier should run independently as part of the task state machine.

### 8.3 Tool design rules

- compact schemas first; control-plane metadata stays outside the model-visible JSON;
- every read carries source version and stable continuation;
- every write states expected source hash/revision;
- patches are transactional and return precise conflicts;
- command output defaults to summary plus artifact handle, not giant transcript;
- diagnostics after writes are automatic and batched;
- tool errors are typed and actionable;
- no raw shell string becomes an external effect without broker classification;
- capability activation changes the cache epoch and is visible in the trace;
- tools are benchmarked by call success, correction turns, token cost, and final task success.

### 8.4 Persistent programmatic execution

Add an optional persistent Python/JavaScript execution capability inspired by Prime Agent, Hermes, and Oh My Pi. It should be isolated, brokered, checkpointable, and able to call safe read/search/artifact APIs. It should not silently inherit secrets or unrestricted network access.

This is especially valuable for:

- repository-wide data analysis;
- log and trace aggregation;
- test-result comparison;
- structured web/research tasks;
- generated migration plans;
- large output filtering without returning everything to the model.

---

## 9. Context compiler and caching: convert theory into measured mechanisms

The Context Compiler is one of Terminus’s strongest design ideas. It explicitly models required authority, task contracts, retrieval queries, evidence coverage, scoring, budget allocation, stable prefixes, provider rendering, manifests, omissions, and replay.

But several implementation details are currently too heuristic to justify performance claims.

### 9.1 Current gaps

- fallback retrieval can return no candidates;
- “semantic compaction” groups fragments by kind and constructs a summary from their first non-empty lines plus evidence hashes;
- model tokenizers are character-ratio estimates with fixed overhead, despite comments describing precise model-aware tokenization;
- scoring weights are hand-chosen;
- there is no demonstrated online calibration against provider-reported usage;
- cache planning is not yet proven to maximize real provider cache hits;
- retrieval and compaction features are not tied to benchmark ablations.

### 9.2 Required context architecture

#### Stable prefix

Keep these deterministic and ordered:

- authority/security boundary;
- compact project instructions;
- task contract and acceptance criteria;
- active tool schemas;
- model/profile-specific operating guidance;
- durable goal/checkpoint state.

Any change should produce an explainable epoch transition and new prefix hash.

#### Volatile suffix

Include only:

- the current user turn;
- the smallest fresh repository evidence needed for the next decision;
- recent complete tool episodes;
- active diagnostics and verification failures;
- explicit unknowns and current plan/progress.

#### Retrieval ladder

Run cheap deterministic retrieval before expensive semantic retrieval:

1. exact user references and paths;
2. changed files, diagnostics, failing tests, and Git diff;
3. lexical/regex search;
4. symbols, references, and syntax tree;
5. dependency/call/import graph;
6. failure localization;
7. semantic retrieval only for remaining evidence gaps.

#### Handoff over endless compression

When the task crosses a phase boundary or context becomes contaminated, create a reviewable handoff bundle:

- objective and acceptance state;
- completed/failed attempts;
- changed files and revision;
- unresolved questions and risks;
- essential evidence handles;
- exact verification status;
- recommended next role and tools.

Use semantic compression only when a focused handoff is not appropriate.

### 9.3 Real token accounting

Use provider or official tokenizer APIs where available; otherwise calibrate model/version-specific estimators from observed requests. The accounting system must include:

- message and control tokens;
- tools and schemas;
- images/documents;
- cached and uncached input;
- reasoning tokens;
- provider envelope;
- retries and continuations;
- compaction/handoff cost.

Every request should reconcile predicted versus observed usage and update a versioned calibration model. If error exceeds a threshold, the profile should be marked degraded.

### 9.4 Context evaluation

For every feature, measure:

- verified task delta;
- fresh input token delta;
- cache hit delta;
- tool-selection error delta;
- context omission failures;
- compaction/handoff recovery;
- latency and cost;
- confidence intervals across task cohorts and seeds.

Do not promote a retrieval source or compaction transform because it “seems intelligent.” Promote it because it improves the declared objective.

---

## 10. Durability and transactional effects: unify the source of truth

Terminus’s typed effect model is conceptually excellent: proposal, authorization, preparation, validation, commit, settlement, uncertainty, compensation, idempotency, and outbox concepts are all present. The problem is that persistence and lifecycle authority are split.

### 10.1 Current gaps

- the reference `DurableTaskRepository` is a process-local `Map` implementation despite its name;
- it is the only implementation found through code search;
- the control service separately implements database persistence and lifecycle behavior through Prisma;
- session epoch replacement creates the new epoch before sealing the old one, so a failure can leave conflicting active state;
- sequence numbers derived from list length are race-prone;
- authorization consumption and effect/outbox updates are not one obvious atomic transaction;
- kernel request idempotency is in-memory with TTL and count limits;
- the jobs manager is an in-memory map with optional JSON snapshots, while documentation describes SQLite for production;
- process output and in-flight process identity are process-local;
- persistence errors after process spawn can leave an untracked live process;
- cleanup paths may ignore persistence errors.

### 10.2 Required authoritative model

Use one durable command/event/effect store. A practical first version can remain SQLite, but it must implement:

- transactional command deduplication;
- optimistic versions or compare-and-swap;
- event append and projection update in one transaction;
- transactional outbox/inbox;
- lease/fencing tokens for workers;
- durable provider attempts and native request IDs;
- durable tool episodes and artifacts;
- durable process/job identity and log offsets;
- effect settlement and compensation state;
- monotonic task/thread/turn/epoch sequences allocated by the database;
- explicit uncertain states after ambiguous external outcomes;
- deterministic replay and projection rebuild.

### 10.3 Authority boundaries

The TypeScript control plane should own cognitive orchestration and durable task transitions. The Rust kernel should own enforcement and execution. Neither should independently invent a second task/effect lifecycle.

A kernel operation should return a signed or MAC-bound receipt containing:

- operation and capability identity;
- input/effect hash;
- workspace/environment identity;
- start/end times;
- side effects and artifacts;
- process/provider identifiers;
- final settlement status.

The control plane persists the receipt and uses it to advance the authoritative task/effect state.

---

## 11. Verification: turn the strongest idea into a real completion gate

The completion-gate code is one of the best parts of the repository. It requires at least one required acceptance criterion, binds criteria to independent predicates, checks source revision and environment identity, requires immutable evidence, validates results and claim-evidence graphs, evaluates completion expressions, and blocks open findings.

### 11.1 Current gaps

- the gate is stronger than the live verifier integration around it;
- external harness verification is mostly a thin adapter helper;
- required manual criteria are categorically denied rather than represented as explicit user acceptance obligations;
- the completion record builder ignores its supplied ID source;
- repository-wide evidence does not yet show real benchmark tasks reaching this gate through live provider/tool execution;
- there is no demonstrated defense against malicious agent-written tests or verifier tampering.

### 11.2 Verification architecture

Separate four roles:

1. **Agent self-check:** fast lint/test/diagnostic loop during work.
2. **Independent deterministic verifier:** commands and predicates selected from the task contract and repository policy, not authored solely by the agent.
3. **Independent model reviewer:** read-only, different prompt and preferably different model family for high-risk tasks.
4. **Human acceptance:** only for subjective/product criteria that cannot be automated; represented explicitly and never confused with automated pass.

### 11.3 Proof bundle

A completion artifact should contain:

- task contract and version;
- final repository revision/tree hash;
- environment image/blueprint digest;
- provider/model/profile versions;
- exact context manifest and request hashes;
- tool/effect receipts;
- test/verification commands and immutable outputs;
- claim-to-evidence graph;
- unresolved and accepted risks;
- cost, latency, token, cache, and intervention metrics;
- final checkpoint and replay instructions.

Completion is a proof-carrying state transition, not the model saying “done.”

---

## 12. Routing and multiple agents: postpone sophistication until data exists

The repository includes a stage-aware router, empirical posterior tracker, and expected-value subagent scheduler. These are the right abstractions, but current scoring is hand-tuned and process-local.

### 12.1 Current router gaps

- model-wide averages are not conditioned on task type, repository, language, tool profile, context length, or risk;
- priors are optimistic and not persisted or versioned;
- cost is estimated from broad price terms rather than predicted input/output/reasoning/cache tokens;
- budget and latency constraints are not fully enforced as reservations;
- posterior statistics do not clearly decay across model or harness version changes;
- routing decisions are not yet proven by counterfactual evaluation.

### 12.2 Current EV scheduler gaps

- expected-value terms are fixed arithmetic over caller-supplied signals;
- the values are not calibrated from historical counterfactuals;
- IDs use time and randomness rather than the domain ID source;
- budget assignment is a fixed ratio-derived amount;
- the scheduler does not itself prove that a delegated worker was created, isolated, observed, synthesized, and verified.

### 12.3 Recommended first routing policy

Begin with deterministic rules:

- one main implementer model selected by explicit profile;
- cheap model only for classification/retrieval when measured safe;
- read-only reviewer/oracle for high-risk or failed-verification tasks;
- vision model only when media is actually present;
- local/offline model for confidential contexts;
- no automatic parallel writer unless the task graph is path-disjoint and worktree-isolated;
- no mid-thread provider switch unless performed through a structured handoff.

Collect data first. Then train or calibrate routing on verified outcomes, not self-reported confidence.

### 12.4 Multi-agent protocol

Every delegation must define:

- objective and non-goals;
- allowed paths, tools, effects, and data;
- input evidence handles;
- output schema and evidence requirements;
- token/time/cost budget;
- workspace isolation mode;
- cancellation and deadline;
- merge/synthesis owner;
- verifier and acceptance criteria.

The default topology should be **single writer + read-only scouts/reviewers**. Parallel writers require separate worktrees and a deterministic integration stage.

---

## 13. Security and isolation: strong kernel direction, incomplete production proof

The Rust kernel is materially stronger than many surrounding TypeScript contracts. It has concrete services for capabilities, policy, filesystem, patching, processes/jobs, egress, secrets, artifacts, sandboxes, connectors, and remote execution, with tests around non-bypassability, capability enforcement, crash recovery, workspace isolation, and secret handling.

### 13.1 What to preserve

- deny unsafe Rust practices and panic/unwrap patterns in the workspace;
- route model-facing actions through a typed kernel protocol;
- keep provider credentials broker-side;
- use secret canaries and egress policy;
- test negative paths and bypass attempts;
- label unsupported sandbox strengths honestly.

### 13.2 What must be completed

- production Linux sandbox with mount/user/network namespace evidence;
- production macOS sandbox with Seatbelt profile evidence;
- Windows isolation or an explicit unsupported boundary;
- optional microVM profile for high-risk and cloud execution;
- streaming connector with bounded frames and cancellation;
- durable capability lease/replay protection across restart;
- durable job/process tracking with PID reuse defenses and fencing;
- trust-before-parse for workspace instructions, plugins, MCP, and hooks;
- plugin/extension execution outside the authority plane;
- signed capability and tool-definition provenance;
- red-team suites for prompt injection, symlink/path traversal, Git redirect, shell escape, credential exfiltration, loopback/metadata access, and approval confusion.

### 13.3 Policy UX

Do not make secure use feel like constant permission popups. Provide:

- readable capability summaries;
- session/task-scoped leases;
- exact host/path/operation boundaries;
- reason and consequence of approval;
- preview of irreversible effects;
- safe bulk approval inside a narrow sandbox;
- immediate cancellation and revocation;
- post-hoc receipts and anomaly alerts.

---

## 14. Computer use: design it as typed software operation

Computer use is currently closer to a north-star contract than a complete implementation. To become genuinely better than current coding agents, Terminus must integrate browser and desktop work into the same task/effect/evidence model as code.

### 14.1 Browser control hierarchy

Use the least ambiguous control mode available:

1. application/API/MCP integration;
2. browser DOM/accessibility tree and semantic locator;
3. CDP/network/storage inspection;
4. browser screenshot plus grounded vision;
5. raw coordinate interaction as last resort.

Each observation should include page/app identity, URL/origin, DOM/accessibility snapshot hash, screenshot hash, active frame, viewport, timestamp, and source version.

### 14.2 Typed browser/desktop effects

Examples:

- `navigate(origin, path)`;
- `click(locator, expected_state)`;
- `fill(locator, value_ref)`;
- `select(locator, option)`;
- `upload(locator, artifact_ref)`;
- `download(expected_media, destination)`;
- `submit(form_ref, consequence_class)`;
- `launch_app(app_id)`;
- `focus_window(window_ref)`;
- `invoke_menu(command_ref)`.

A purchase, message send, permission grant, data deletion, deployment, or account change must settle through the external-effect state machine, not a generic click.

### 14.3 Recovery and verification

- observe after every consequential action;
- detect stale locators and changed page identity;
- checkpoint authenticated browser state without exposing cookies to the model;
- record visual/DOM evidence before and after external effects;
- verify success independently through state, network response, receipt, or downstream system;
- support user takeover without losing task state;
- replay the action trace in evaluation.

### 14.4 Evaluation suites

Use BrowserGym, WorkArena, WebArena-Verified, and a private rotating suite of real developer workflows. Add cross-modal tasks: fix code, launch app, verify UI, inspect logs, open PR, respond to review, and confirm CI.

---

## 15. UX and product architecture: one truth, multiple densities

Terminus has CLI, TUI, desktop, and IDE/ACP surfaces, but the CLI is currently a serious non-interactive operational client rather than a polished coding experience. The desktop is experimental. The product should not reproduce the same complex cockpit everywhere.

### 15.1 Shared client protocol

All clients should consume the same authoritative projections and event stream:

- task/thread/turn status;
- current objective and acceptance state;
- active model/profile and budget;
- tool/effect lifecycle;
- workspace revision and changed files;
- approvals and questions;
- verification evidence and findings;
- checkpoints, handoffs, artifacts, and logs;
- interventions and cancellation.

No client should own durable execution or invent local truth.

### 15.2 Surface roles

- **CLI:** scripting, CI, headless tasks, JSON/JSONL, exact exit semantics.
- **TUI:** fastest interactive coding loop; diff, tools, jobs, diagnostics, approvals, resume.
- **IDE:** code-context selection, inline diff/review, diagnostics, task handoff.
- **Desktop:** multi-task and multi-agent supervision, environment/computer-use view, artifacts, long-running work.
- **Web/mobile:** status, intervention, approval, question resolution, review, takeover—not full code editing by default.

### 15.3 Required UX principles

- show progress as verified state, not theatrical chain-of-thought;
- distinguish thinking, blocked, running tool, waiting for external system, and verifying;
- make current revision/environment/model/profile visible;
- make context and memory inclusion explainable on demand;
- surface stale runtime/process problems explicitly;
- one-click open exact changed artifact and evidence;
- preserve user steering mid-turn;
- support interrupt, redirect, handoff, checkpoint, clone, retry, and rollback;
- measure human attention and repeated clarification as product failures.

---

## 16. Evaluation and evolution: build the proof machine before the self-improving machine

The Python eval plane contains many good concepts: baselines, cohorts, conformance levels, hidden-test protection, experiment manifests, graders, promotion gates, and an evolution lab. Its breadth is ahead of the live agent.

### 16.1 Current problems

- no public evidence of a real Terminus benchmark run;
- no real external-harness adapter execution;
- the SWE-bench Verified fixture uses an all-zero image digest;
- it describes JavaScript/TypeScript and Go cohorts even though canonical SWE-bench Verified is a 500-task human-verified Python-repository subset;
- no complete Harbor/Terminal-Bench 2.0 adapter was found through code search;
- no OSWorld/BrowserGym execution evidence was found;
- synthetic/unit evals cannot substitute for live end-to-end outcomes.

### 16.2 Minimum benchmark matrix

Run at least:

- Terminal-Bench 2.0 through Harbor;
- SWE-bench Verified for continuity, with contamination caveat;
- a fresh/rotating SWE repair suite built from post-cutoff or private repositories;
- Aider Polyglot or equivalent multi-language edit suite;
- security and adversarial tool/effect suites;
- crash/resume/ambiguity/duplicate-effect chaos suite;
- BrowserGym, WorkArena, and WebArena-Verified;
- real-product dogfood tasks sampled from Terminus development.

### 16.3 Experimental design

Use a factorial manifest:

`model × harness × profile × effort × task × seed × environment`

Requirements:

- pinned code revisions, model IDs, provider endpoints, prompts, tool schemas, dependencies, images, and graders;
- randomized task order;
- repeated seeds for stochastic systems;
- cost and latency distributions, not only means;
- bootstrap confidence intervals;
- paired tests where the same task/model is compared across harnesses;
- explicit failed/invalid run policy;
- hidden tests and rotating private cohorts;
- artifact publication sufficient for independent replay.

### 16.4 Required ablations

At minimum:

- minimal shell loop;
- compact ACI;
- Context Compiler off/on;
- exact/lexical/symbol/semantic retrieval ladders;
- stable-prefix cache planning off/on;
- progressive tool disclosure off/on;
- compaction versus handoff;
- verifier off/self-check/independent deterministic/independent model;
- single-agent versus read-only scout versus parallel writers;
- fixed model versus stage routing;
- local versus snapshotted environment;
- provider-native renderer versus generic compatibility renderer.

### 16.5 Promotion policy

A feature can enter the default profile only if:

- it improves the primary objective or satisfies a hard safety/reliability gate;
- confidence intervals exclude a material regression on protected cohorts;
- failure cases are reviewed;
- cost and human attention are accounted for;
- the change has a rollback path;
- the profile version and evidence artifact are signed.

The evolution lab must remain sealed from production secrets, user workspaces, and hidden graders. It proposes; a deterministic promotion service validates and deploys.

---

## 17. Recommended north-star architecture

### 17.1 Two planes

#### Trusted authority/effects plane

- identity, policy, and capability leases;
- environment/workspace lifecycle;
- filesystem, process, network, secrets, browser, desktop, and external connectors;
- transactional effect state and receipts;
- content-addressed artifacts;
- durable event and command log;
- independent verification;
- signing, provenance, audit, and replay.

#### Adaptive cognitive plane

- task understanding and contracts;
- context compilation and retrieval;
- provider-native rendering;
- model selection and handoff;
- plans/workflows;
- selective delegation;
- memory and skills;
- review and synthesis;
- experiment assignment.

The cognitive plane never directly crosses the effect boundary.

### 17.2 One canonical runtime, four profiles

#### Profile A — Native Performance

Purpose: highest coding benchmark quality and lowest overhead.

- local Git workspace or worktree;
- one strong model by default;
- compact coding ACI;
- native provider transcripts and cache planning;
- exact/lexical/symbol retrieval;
- targeted tests plus independent completion gate;
- no durable cloud, browser, broad connectors, or multi-agent unless activated.

#### Profile B — Governed Local

Purpose: daily power-user and sensitive repository work.

- Profile A plus Rust broker;
- filesystem/egress/secrets boundaries;
- capabilities and approvals;
- durable local event/effect journal;
- persistent jobs and checkpoints;
- signed receipts and audit.

#### Profile C — Durable Cloud

Purpose: long-running team and enterprise work.

- snapshotted/microVM environments;
- durable worker leases and recovery;
- organization knowledge and policies;
- source-control/issues/chat integrations;
- scheduled tasks and automations;
- multi-agent supervision and worktree/VM isolation;
- web/mobile control surface.

#### Profile D — Computer Use

Purpose: browser/desktop/software-operation tasks.

- typed browser/desktop ACI;
- DOM/accessibility/CDP-first control;
- visual model fallback;
- secret and cookie broker;
- external-effect approvals and receipts;
- replay and visual evidence.

### 17.3 Profile invariants

- same task/effect/evidence identity across profiles;
- same authoritative event protocol;
- no client-owned execution;
- no plugin-owned authority;
- provider-specific semantics preserved;
- every activated subsystem is present in the trace and cost accounting;
- defaults chosen by measured cohort performance, not architecture preference.

---

## 18. Prioritized implementation roadmap

The roadmap is organized by dependency, not product excitement.

### Phase 0 — Freeze and expose truth

**Goal:** make current capability impossible to misunderstand.

1. Add `terminus doctor` that tests database, kernel protocol, sandbox strength, provider admission, model discovery, connector streaming, workspace, Git, job durability, verifier, client protocol, signing, and benchmark availability.
2. Generate the support/maturity matrix from executable probes, not comments.
3. Rename stale root package metadata such as `terminus-dashboard` and remove unrelated or unused dependencies from the trusted/product path.
4. Mark every endpoint, client action, adapter, tool, provider, sandbox, and eval as production/preview/experimental/stub/fixture in generated docs and API metadata.
5. Fail startup when a claimed production invariant cannot be proven.

**Exit gate:** a new developer can install the system, run `doctor`, configure one provider, and understand exactly which path is live.

### Phase 1 — Native provider and transcript conformance

**Goal:** two correct live providers.

1. Implement native OpenAI Responses and Anthropic Messages connectors through Rust secrets/egress.
2. Implement model catalogue fetch/admission with pinned snapshot and offline fallback.
3. Implement real frame streaming, cancellation, timeouts, retries, native continuation IDs, and bounded persistence.
4. Correct tool-call/result IDs, reasoning, structured output, images, cache controls, and usage.
5. Build golden and live provider conformance suites.
6. Record exact raw/semantic transcript artifacts and downgrade decisions.

**Exit gate:** 10,000 randomized transcript/tool episodes across both providers with no conformance failure; cancel and resume tests pass.

### Phase 2 — Minimal benchmark-grade coding loop

**Goal:** one complete, small, fast vertical slice.

1. Define the compact coding ACI and provider-tuned descriptions.
2. Implement hash-anchored edits and transactional patches.
3. Auto-run diagnostics after writes.
4. Add bounded shell, durable jobs, artifact continuation, and targeted verify.
5. Build the deterministic end-to-end fake-provider test.
6. Split the control monolith around turn/provider/tool/effect/verification services.
7. Ship the fastest TUI flow over the same protocol.

**Exit gate:** Terminus can solve a curated local repair suite end to end, restart mid-task, and produce proof bundles.

### Phase 3 — Durable authoritative state

**Goal:** exactly-once intent and recoverable execution.

1. Replace in-memory task/effect repositories with the authoritative DB implementation.
2. Add command deduplication, optimistic versions, transactional event+projection+outbox, inbox, leases, and fencing.
3. Make epochs/turn sequences database allocated and transactional.
4. Persist provider attempts, native IDs, tool episodes, jobs, log offsets, effects, settlements, and checkpoints.
5. Reconcile unknown outcomes after crash/network loss.
6. Remove duplicate lifecycle logic from control and reference packages.

**Exit gate:** 24-hour fault-injection soak with process kills, network partitions, duplicate requests, and restart; zero duplicate irreversible effects and deterministic projection rebuild.

### Phase 4 — Independent verification and proof

**Goal:** make false completion rare and measurable.

1. Compile acceptance criteria into verifier predicates.
2. Add trusted repository commands, hidden tests, static analysis, security checks, and UI/browser predicates.
3. Isolate verifier workspace and credentials.
4. Add read-only model reviewer profile for selected risks.
5. Produce immutable proof bundles and completion receipts.
6. Add explicit human-acceptance obligations for subjective criteria.

**Exit gate:** adversarial tasks cannot pass by editing tests, verifier config, evidence, or completion records.

### Phase 5 — Benchmark and ablation laboratory

**Goal:** establish harness contribution.

1. Implement Harbor agent adapter and Terminal-Bench 2.0 runs.
2. Repair SWE-bench metadata and pin real images/dataset revisions.
3. Add rotating private SWE tasks and multi-language cohorts.
4. Record exact model/harness/profile/effort/seed/environment manifests.
5. Run minimal shell, Pi, Codex CLI, Claude Code, and Terminus profiles where licensing/access permits.
6. Build paired analyses, confidence intervals, failure taxonomy, and cost/human-attention accounting.
7. Publish replayable evidence.

**Exit gate:** the Native Performance profile demonstrates statistically credible same-model advantage or Pareto improvement on protected cohorts.

### Phase 6 — Context and cache leadership

**Goal:** reduce tokens without degrading correctness.

1. Implement real retrieval indexes and source freshness.
2. Replace character-ratio token claims with calibrated tokenizers.
3. Build stable-prefix/cache debugger and epoch visualizer.
4. Implement capability-card deferred schemas.
5. Implement reviewable handoffs and conservative evidence-linked compaction.
6. Tune scoring through offline counterfactual replay and online experiments.
7. Add cache and context waste budgets to CI/evals.

**Exit gate:** measured reduction in fresh input and tool-selection errors with no material success regression.

### Phase 7 — Selective routing and multi-agent

**Goal:** use extra models only when they pay.

1. Persist versioned task-conditioned performance data.
2. Implement deterministic role routing first.
3. Add read-only scout/reviewer/oracle workers.
4. Add worktree-isolated parallel writers behind strict separability rules.
5. Add synthesis, conflict detection, and independent verification.
6. Train/calibrate expected-value policies on historical counterfactuals.
7. Enforce concurrency, budget reservations, and cancellation.

**Exit gate:** selected cohorts show higher verified success per dollar-hour than the single-agent profile.

### Phase 8 — Prepared environments and durable cloud

**Goal:** Devin/Cursor-class long-running execution.

1. Declarative environment blueprints and `doctor` verification.
2. Local container and remote microVM providers.
3. Snapshot/build caches and clean session cloning.
4. Secret/OIDC broker and private network policy.
5. Durable worker leases, scheduling, pause/resume, and migration.
6. organization knowledge with trigger/provenance UI.
7. source-control/issues/chat/deploy integrations as brokered effects.

**Exit gate:** tasks resume on a new worker from durable state and exact environment identity; no credential enters model-visible context.

### Phase 9 — Computer use

**Goal:** integrated browser/desktop software operation.

1. Browser pool with DOM/accessibility/CDP observations.
2. Typed locators/actions and visual fallback.
3. Cookie/secret broker and authenticated state snapshots.
4. Desktop/VM control with window/app identity.
5. Consequence classification and external-effect settlement.
6. visual/DOM replay artifacts and user takeover.
7. BrowserGym/WorkArena/WebArena-Verified and private developer workflow suites.

**Exit gate:** computer-use profile beats a vision-only baseline and passes effect/security tests.

### Phase 10 — Product polish, release, and evolution

**Goal:** trustworthy daily use and controlled self-improvement.

1. Unified TUI/desktop/IDE/web/mobile projections.
2. task supervision, diff/review, evidence, approval, takeover, and intervention UX.
3. release signing, SBOM, provenance, reproducible builds, update channels, rollback.
4. plugin/skill marketplace with signatures, capabilities, and schema budgets.
5. sealed evolution lab with proposed harness diffs, held-out evaluation, human review, canary, and rollback.
6. public benchmark/evidence dashboard.

**Exit gate:** signed release, cross-platform install/upgrade/rollback, held-out promotion evidence, and daily dogfood without hidden manual repair.

---

## 19. First twelve pull requests

These are the most useful concrete next changes.

### PR 1 — Executable truth and `terminus doctor`

- provider/model/sandbox/kernel/database/job/verifier probes;
- generated maturity/support output;
- stale metadata cleanup;
- fail-closed production profile validation.

### PR 2 — Provider transcript conformance harness

- semantic transcript fixtures;
- OpenAI Responses and Anthropic Messages golden requests/events;
- tool-call/result linkage tests;
- cache, usage, refusal, cancellation, retry, and continuation fixtures.

### PR 3 — Native OpenAI connector

- Rust-brokered secret and egress;
- true stream framing;
- cancellation and deadlines;
- exact usage/cache receipt;
- live opt-in conformance test.

### PR 4 — Native Anthropic connector

Same standard as PR 3, including native `tool_use`/`tool_result`, thinking controls, and cache blocks.

### PR 5 — Model catalogue admission

- implement catalogue fetch;
- hash/signature pin;
- offline snapshot;
- cache/expiry;
- explicit profile admission and downgrade metadata.

### PR 6 — Minimal coding ACI v1

- compact tool schemas;
- hash-anchored edit;
- transactional patch;
- targeted diagnostics;
- bounded shell/job/artifact continuation;
- schema token measurement.

### PR 7 — End-to-end turn spine

- deterministic streaming fake provider;
- real kernel and Git workspace;
- provider→tool→edit→verify→complete;
- disconnect/reconnect and restart;
- proof bundle.

### PR 8 — Control-service decomposition

Extract authoritative services while preserving behavior and end-to-end tests. No speculative framework rewrite.

### PR 9 — Durable task/effect store

- transactional commands/events/projections/outbox;
- idempotency and optimistic version;
- epoch/turn sequence fixes;
- durable provider/tool/effect attempt state.

### PR 10 — Durable jobs and streaming logs

- database-backed job/process identity;
- log chunks/artifacts and resume offsets;
- spawn/persist atomicity strategy;
- kill/restart/PID reuse/fencing tests.

### PR 11 — Independent verifier and proof bundle

- acceptance binding;
- immutable revision/environment evidence;
- verifier isolation;
- adversarial completion tests.

### PR 12 — Harbor and fresh-SWE benchmark adapters

- real environment images;
- exact manifests;
- minimal-shell and Terminus baselines;
- paired reports with cost/tokens/cache/human attention.

---

## 20. What not to build yet

The repository should deliberately defer:

- broad external-harness adapters beyond one real reference adapter;
- autonomous prompt/skill self-rewrite in production;
- learned EV routing before verified historical data;
- many specialized agents or role taxonomies;
- marketplace/plugin breadth;
- enterprise organization hierarchy beyond what the durable task model needs;
- broad desktop visual automation before the browser semantic path works;
- multiple remote sandbox vendors before one local and one cloud implementation pass conformance;
- custom vector database infrastructure before lexical/symbol/graph retrieval is measured;
- elaborate UI dashboards that visualize states the runtime cannot yet guarantee;
- backward compatibility for experimental contracts that obstruct simplification.

The rule should be: **no new subsystem without a live task, an activation policy, telemetry, an ablation, and an owner.**

---

## 21. Release and evidence gates

### Gate G0 — Live native loop

- two native providers;
- exact tool semantics;
- stream/cancel/resume;
- one complete coding task;
- no fake provider or fixture path.

### Gate G1 — Performance parity

- same-model locked-harness runs against minimal shell and strong open baselines;
- no material success regression;
- competitive cost/latency/token profile;
- published failure taxonomy.

### Gate G2 — Durability

- 24-hour soak;
- crash and partition injection;
- idempotent replay;
- zero duplicate irreversible effects;
- deterministic projection rebuild.

### Gate G3 — Security

- no direct effect bypass;
- no unauthorized path/host/secret access;
- capability replay and expiry tests;
- plugin/MCP/workspace-instruction adversarial tests;
- independent security review.

### Gate G4 — Verification

- required criteria bound to independent predicates or explicit human acceptance;
- revision/environment binding;
- malicious test/evidence tampering fails;
- false-completion rate measured.

### Gate G5 — Context and cache

- calibrated token error within declared bound;
- stable-prefix cache measurements;
- progressive disclosure improves objective or hard limit;
- compaction/handoff regressions below threshold.

### Gate G6 — UX

- users can install, configure, start, steer, interrupt, resume, review, and recover;
- human attention measured;
- all clients show the same authoritative state;
- stale runtime/environment errors are explicit.

### Gate G7 — Computer use

- semantic browser control before vision fallback;
- typed external effects and receipts;
- replayable observations;
- benchmark and private workflow evidence.

### Gate G8 — Release and evolution

- signed artifacts, SBOM, provenance, reproducible build evidence;
- upgrade/rollback tested;
- evolution proposals evaluated on held-out tasks;
- canary and automatic rollback.

Only after G0–G4 should Terminus describe itself as a serious harness. Only after G1, G5, and public benchmark evidence should it describe a profile as benchmark-leading. “Objectively best” should be reserved for a declared scorecard on which Terminus demonstrably Pareto-dominates named alternatives.

---

## 22. Provisional scorecard

This scorecard is a static engineering judgment, not a benchmark result.

| Dimension | Current | Why | Evidence needed for 9/10 |
|---|---:|---|---|
| North-star architecture | 9.0 | unusually coherent authority/effects/context/evidence vision | stable implementation with fewer duplicate abstractions |
| Security design | 7.5 | strong non-bypassable kernel direction | cross-platform sandbox and red-team evidence |
| Security implementation | 5.0 | meaningful Rust tests, incomplete production boundary | live bypass/exfiltration suites and external review |
| Provider fidelity | 2.5 | renderers/transports exist, discovery and transcript fidelity incomplete | two live native conformance-certified providers |
| Native agent loop | 3.0 | much of the state machine exists, default useful path absent | end-to-end live task and benchmark spine |
| ACI/tool ergonomics | 3.5 | rich contracts and tool implementations | compact schemas and model/tool reliability evidence |
| Context/cache efficiency | 3.0 | excellent design, heuristic tokenizer/compaction | calibrated usage, cache debugger, successful ablations |
| Durability/recovery | 4.0 | event/effect concepts plus partial recovery | transactional authoritative store and chaos soak |
| Verification | 4.0 | strong completion gate, weak live proof integration | adversarial independent verification on real tasks |
| Multi-agent/routing | 3.0 | contracts and heuristics exist | task-conditioned measured policies and worktree execution |
| Computer use | 1.5 | architecture/research present | real browser/desktop executors and evals |
| UX/product | 4.0 | several clients and operational API | polished shared-runtime daily workflow and user study |
| Extensibility | 3.0 | broad declarations, stubs and trust questions | one real signed adapter/plugin path and conformance |
| Evaluation evidence | 1.5 | broad eval framework, no live leadership proof | pinned public/private benchmark artifacts |
| Release/operations | 2.0 | runbooks and reconciliation, unsigned experimental app | signing, SBOM, provenance, install/upgrade/rollback |

**Overall current state:** approximately **3.5/10 as a working product**, while the architecture vision is much stronger. This is not a criticism of ambition; it is a warning that adding more architecture now will lower the chance that the existing vision becomes real.

---

## 23. Success definition for the next major milestone

The next milestone should be called something like **Native Spine Alpha**, and it should have a brutally narrow definition:

- installable on macOS and Linux;
- `terminus doctor` passes;
- one admitted OpenAI model and one admitted Anthropic model;
- interactive TUI and headless CLI over the same runtime;
- compact read/search/edit/shell/job/inspect tool set;
- all effects through the Rust broker;
- exact context manifest and token/cache accounting;
- transactional task/effect/provider state;
- restart and resume;
- independent verification and proof bundle;
- Harbor/SWE repair evaluation with minimal-shell control;
- no adapter, cloud, multi-agent, computer-use, marketplace, or evolution requirement.

A small release that proves this is worth more than another year of broad contracts.

---

## 24. Final recommendation

Terminus should not try to win by having the most features. It should win by combining four properties that no current system consistently unifies:

1. **Pi-level loop clarity and efficiency.**
2. **Codex/Devin-level shared runtime and durable environment product.**
3. **Claude Code-level enforced containment.**
4. **Terminus’s own proof-carrying tasks, transactional effects, and reproducible evolution.**

The order matters. First make the thin loop excellent. Then put it behind the trusted kernel. Then make it durable. Then prove it. Then add selective intelligence. Then add cloud and computer use. Then let the system improve itself under a sealed evidence gate.

The single most important next implementation move is:

> **Build native provider conformance plus the minimal end-to-end coding spine, and use it to run the first same-model locked-harness benchmark before adding another major subsystem.**

---

# Appendix A — Commit-pinned repository evidence map

The repository evidence below was inspected at revision `0cd373cef6d568df4891c84032d43b49f08e076e` unless otherwise noted.

| ID | Evidence | Location |
|---|---|---|
| R1 | Product claims, architecture, quickstart, non-bypassability | `README.md` |
| R2 | Static package/crate/app/test/ADR/runbook inventory | `docs/generated/inventory.md` |
| R3 | Component maturity and explicit missing gates | `docs/generated/component-maturity.md` |
| R4 | August 24 implementation reconciliation | `Terminus — Research/implementation-reconciliation.md` |
| R5 | North-star competitive research | `Terminus — Research/research.md` |
| R6 | Earlier implementation audit and failure patterns | `Terminus — Research/terminus-audit.md` |
| R7 | Prior milestone roadmap | `Terminus — Research/roadmap.md` |
| R8 | Prior provisional scorecard | `Terminus — Research/scorecard.md` |
| R9 | North-star architecture | `Terminus — Research/architecture.md` |
| R10 | Evaluation methodology | `Terminus — Research/evals.md` |
| R11 | Research source inventory | `Terminus — Research/sources.md` |
| R12 | OpenAI provider renderer | `packages/provider-openai/src/index.ts` |
| R13 | Anthropic provider renderer | `packages/provider-anthropic/src/index.ts` |
| R14 | Provider semantic contracts | `packages/provider-core/src/index.ts` |
| R15 | Gateway provider stream normalization | `packages/provider-zen/src/transport.ts` |
| R16 | Kernel-brokered gateway connector | `mini-services/terminus-control/src/gateway-kernel-client.ts` |
| R17 | Provider model discovery and catalogue gap | `mini-services/terminus-control/src/provider-models.ts` |
| R18 | Kernel-brokered local provider command | `mini-services/terminus-control/src/provider-command.ts` |
| R19 | Control service operational truth and default block | `mini-services/terminus-control/README.md` |
| R20 | Main control-service hot path | `mini-services/terminus-control/src/index.ts` |
| R21 | Session/epoch service contracts | `packages/session-runtime/src/index.ts` |
| R22 | Task/effect runtime | `packages/task-runtime/src/effects.ts` |
| R23 | Reference task repository | `packages/task-runtime/src/repository.ts` |
| R24 | Kernel boundary and tests | `crates/terminus-kernel/README.md` |
| R25 | Kernel runtime state | `mini-services/terminus-kernel/src/state.rs` |
| R26 | In-memory request idempotency | `mini-services/terminus-kernel/src/idempotency.rs` |
| R27 | Jobs documentation | `crates/terminus-jobs/README.md` |
| R28 | Jobs manager implementation | `crates/terminus-jobs/src/manager.rs` |
| R29 | Context compiler | `packages/context-compiler/src/index.ts` |
| R30 | Compaction implementation | `packages/context-compiler/src/compaction.ts` |
| R31 | Token estimator implementation | `packages/context-compiler/src/tokenizer.ts` |
| R32 | Agent-computer interface and progressive disclosure | `packages/aci/src/index.ts` |
| R33 | Stage router | `packages/model-router/src/stage_router.ts` |
| R34 | Performance posterior tracker | `packages/model-router/src/posterior.ts` |
| R35 | Expected-value subagent scheduler | `packages/orchestration/src/ev_scheduler.ts` |
| R36 | Completion gate | `packages/verification/src/completion-gate.ts` |
| R37 | External-harness verification helper | `packages/verification/src/harness-verify.ts` |
| R38 | CLI | `apps/cli/src/index.ts` |
| R39 | TUI | `apps/tui/src/*` |
| R40 | Adapter inventory | `adapters/*` |
| R41 | Codex stub adapter | `adapters/codex/runner.ts` |
| R42 | Eval framework | `python/forge_evals/forge_evals/*` |
| R43 | SWE-bench Verified fixture | `evals/suites/swe-bench-verified.yaml` |

Repository base URL: `https://github.com/ezzy1630/Terminus`

---

# Appendix B — Primary external sources

| ID | Source | URL | Use in this report |
|---|---|---|---|
| S1 | Pi Agent Harness repository | https://github.com/earendil-works/pi | minimal core, packages, permissions boundary |
| S2 | Oh My Pi coding agent repository | https://github.com/can1357/oh-my-pi | coding ACI, LSP, hash edits, REPL, subagents |
| S3 | mini-SWE-agent documentation | https://mini-swe-agent.com/latest/ | minimal shell-loop control condition |
| S4 | Hermes Agent repository | https://github.com/NousResearch/hermes-agent | memory, skills, schedules, messaging, subagents, RPC |
| S5 | Prime Agent repository | https://github.com/PrimeIntellect-ai/prime-agent | continual harness state, refinement, rollback, RLM concepts |
| S6 | OpenAI — Introducing the Codex app | https://openai.com/index/introducing-the-codex-app/ | app, multi-agent, automations, shared use surfaces |
| S7 | OpenAI — Unlocking the Codex harness | https://openai.com/index/unlocking-the-codex-harness/ | shared harness and App Server protocol |
| S8 | Anthropic — Claude Code sandboxing | https://www.anthropic.com/engineering/claude-code-sandboxing | OS filesystem/network isolation |
| S9 | Anthropic — How we contain Claude | https://www.anthropic.com/engineering/how-we-contain-claude | containment boundary versus probabilistic controls |
| S10 | Claude Code subagent documentation | https://code.claude.com/docs/en/sub-agents | scoped tools/models/permissions/worktrees/skills |
| S11 | Cursor Cloud Agents documentation | https://cursor.com/docs/cloud-agent | VMs, parallel/multi-repo, computer use, distributed surfaces |
| S12 | Devin environment setup | https://docs.devin.ai/onboard-devin/environment | snapshots and environment leverage |
| S13 | Devin environment blueprints | https://docs.devin.ai/onboard-devin/environment/blueprints | declarative reviewed environment setup |
| S14 | Devin knowledge onboarding | https://docs.devin.ai/onboard-devin/knowledge-onboarding | trigger retrieval and visible knowledge provenance |
| S15 | Factory — Deferred Context Engine | https://factory.ai/news/deferred-context-engine | schema deferral and vendor token telemetry |
| S16 | Amp — Agents, Everywhere | https://ampcode.com/news/agents-everywhere | shared distributed surfaces |
| S17 | Amp — Handoff | https://ampcode.com/news/handoff | reviewable focused thread handoff |
| S18 | GitHub Copilot custom agents | https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-custom-agents | scoped agent profiles |
| S19 | GitHub Copilot SDK subagent orchestration | https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/custom-agents | isolated specialist agents and events |
| S20 | Google — Transitioning Gemini CLI to Antigravity CLI | https://developers.googleblog.com/en/an-important-update-transitioning-gemini-cli-to-antigravity-cli/ | current product succession and unified backend |
| S21 | Google I/O 2026 developer highlights | https://blog.google/innovation-and-ai/technology/developers-tools/google-io-2026-developer-highlights/ | Antigravity 2.0, dynamic subagents, scheduling, CLI |
| S22 | OpenHands repository | https://github.com/All-Hands-AI/OpenHands | open runtime/sandbox/deployment reference |
| S23 | Harbor repository | https://github.com/harbor-framework/harbor | official Terminal-Bench 2.0 evaluation harness |
| S24 | Terminal-Bench 2.0 repository | https://github.com/harbor-framework/terminal-bench-2 | terminal task benchmark artifacts |
| S25 | OpenAI — SWE-bench Verified | https://openai.com/index/introducing-swe-bench-verified/ | 500 human-verified Python tasks and limitations |
| S26 | SWE-bench Verified site | https://www.swebench.com/verified.html | official benchmark/leaderboard context |
| S27 | BrowserGym repository | https://github.com/ServiceNow/BrowserGym | browser-agent evaluation environment |
| S28 | WorkArena repository | https://github.com/ServiceNow/WorkArena | knowledge-work browser evaluation |
| S29 | WebArena-Verified repository | https://github.com/ServiceNow/webarena-verified | verified web-task benchmark |
| S30 | KIRA repository | https://github.com/krafton-ai/KIRA | optimized agent/harness and naming disambiguation |
| S31 | Meta-Harness Terminal-Bench 2 artifact | https://github.com/stanford-iris-lab/meta-harness-tbench2-artifact | harness optimization artifact; treat score as artifact claim |

---

# Appendix C — Evidence quality and remaining research gaps

| Question | Evidence quality | Remaining gap |
|---|---|---|
| What is Terminus trying to be? | High: spec, architecture, README, ADRs, research | product priority still too broad |
| Which components are real? | Medium-high: generated maturity matrix plus code audit | executable probes and independent test run needed |
| Does the provider path work live? | Low-medium: code and docs show configured paths | live credentials, catalogue admission, conformance, streaming needed |
| Is the kernel non-bypassable? | Medium: meaningful unit/integration evidence in repo | cross-platform live red-team and independent review needed |
| Is state durable and exactly-once? | Low-medium: contracts plus partial DB/JSON/in-memory implementations | chaos soak and one authoritative store needed |
| Does context compilation improve results? | Low: strong theory, heuristic mechanisms | same-model ablations needed |
| Does routing/delegation improve results? | Low: fixed heuristics | task-conditioned empirical policy and counterfactual data needed |
| Does verification prevent false completion? | Medium in contract, low in live tasks | adversarial end-to-end benchmark evidence needed |
| Is computer use competitive? | Very low | real executor, replay, security, and benchmark evidence needed |
| Is Terminus better than named competitors? | None yet | locked/native benchmark matrix with published artifacts needed |
| Can Terminus self-improve safely? | Conceptual only | sealed held-out promotion, signing, canary, rollback needed |

---

# Appendix D — Definitions

- **Harness:** the runtime around a model that constructs context, exposes tools, executes actions, manages state, routes work, verifies outcomes, and presents the experience.
- **Profile:** a versioned set of harness mechanisms and policies activated for a task cohort.
- **Effect:** an operation that changes workspace, process, network, secret, external system, or durable state.
- **Receipt:** durable evidence that an effect or provider operation was proposed, authorized, attempted, and settled.
- **Proof bundle:** immutable artifacts binding completion claims to code revision, environment, provider/model/profile, tool/effect receipts, and verification results.
- **Stable prefix:** deterministic provider-visible context intended to remain cacheable across turns.
- **Handoff:** a focused, reviewable transfer bundle to a new thread, role, model, or environment.
- **Locked-harness evaluation:** same model/task/environment/budget, harness varies.
- **Native-harness evaluation:** each product runs its best supported stack.
- **Pareto dominance:** one system is no worse on all declared metrics and materially better on at least one, subject to hard gates.


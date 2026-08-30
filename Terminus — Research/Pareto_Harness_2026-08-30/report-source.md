# Terminus Pareto-leading harness: research, audit, and execution roadmap

Date: 2026-08-30

Research cutoff: 2026-08-30

Repository observed: `/Volumes/Neural/Terminus`, implementation baseline `main` at `c8768b5ddb6649f3504c281fcc56482abfc4a707`

Evidence state: sixteen local commits ahead of `origin/main`; the checkout also contains a large pre-existing uncommitted desktop, control-plane, kernel-account, and provider-account change set. The implementation commits in this program were validated from a disposable checkout whose source tree exactly matched the corresponding `main` tree. The unrelated uncommitted paths are not attributed to this program and are not evidence for a clean release candidate.

## Direct answer

Terminus is not yet proven to be the best coding harness. It does have a credible route to becoming Pareto-leading.

Its strongest differentiators are already real code: a Rust effect boundary, immutable context manifests, task and scope contracts, content-addressed artifacts, durable semantic events, cache accounting, typed verification, and evidence-gated completion. Competitors are generally stronger today on one or more complete product paths: Codex on the integrated macOS task surface and efficient model-native loop; Claude Code on a disciplined tool loop, sandbox usability, and long-horizon practices; Devin on reproducible cloud environments and browser-backed verification; Pi on minimalism and inspectable branchable sessions; Hermes on exact session retrieval and browser ACI; Prime Agent on programmatic orchestration and recoverable persistent execution.

The highest-impact strategy is therefore not to add every competitor feature. It is to close and measure one complete path:

`real provider -> cache-stable context -> model-native tools -> kernel effects -> independent verification -> durable recovery -> rendered client evidence`

Everything else should be promoted only when a paired, held-out cohort improves verified quality per dollar and per second without weakening reliability or authority.

## What Pareto-leading means

A harness change wins only if it is non-inferior on verified task quality and security while improving at least one constrained dimension:

- verified completion and false-completion rate;
- tokens, dollars, provider calls, and cache writes per verified solve;
- wall time, time to first useful action, and user-blocked time;
- recovery rate after provider, process, client, and host interruption;
- tool-call validity, repeated-work rate, and verifier repair rate;
- policy violations, cross-scope reads, secret exposure, and ambiguous effects;
- human comprehension: visible state, exact approvals, reversible control, and artifact-backed completion.

Claims must hold under the same model, reasoning effort, task, environment, authority, retry policy, and grader. Vendor benchmark claims are hypotheses until reproduced under those controls.

## Research method

The competitive pass used current first-party documentation, first-party engineering posts, papers, and source code. Marketing outcome numbers are reported as vendor claims, not independent facts. Terminus findings were checked against the current checkout; the 2026-08-29 audit was used as a regression hypothesis list rather than current truth.

Fact labels in this report:

- **Observed:** directly present in current source, a current first-party source, or an executed test.
- **Reported:** stated by a system's authors but not independently reproduced here.
- **Inference:** a design conclusion derived from observed or reported mechanisms.
- **Open:** unavailable, disabled, blocked, or not verified on the exact product path.

## Mechanisms that make the leading harnesses effective

### Codex

Observed mechanisms:

- The current model guide treats the harness and model as a joint system: explicit prompt caching, persisted reasoning, provider-side compaction, programmatic tool calling, and multi-agent controls are request-construction choices rather than generic chat options.
- OpenAI reports that a leaner internal coding prompt improved its internal coding evaluation by 10–15% while reducing tokens by 41–66%, cost by 33–67%, and latency by 20‒40%. This is an OpenAI result, not an independent benchmark.
- The open-source runtime retains causal response items, tool calls, tool results, reasoning replay, compaction state, and durable thread state instead of flattening everything into prose.
- The macOS app makes isolated worktrees, task switching, review, terminals, diffs, and background work part of one task product rather than separate utilities.

Why it matters:

- Stable prefixes and persisted provider-native state lower cost without discarding reasoning continuity.
- Lean instructions reduce selection noise. More scaffolding is not automatically better.
- A local task/worktree/review surface makes parallelism comprehensible and reversible.

Primary sources:

- <https://developers.openai.com/api/docs/guides/latest-model>
- <https://learn.chatgpt.com/docs/app>
- <https://learn.chatgpt.com/docs/features>
- <https://learn.chatgpt.com/docs/environments/git-worktrees>
- <https://github.com/openai/codex>

### Claude Code and Anthropic harness research

Observed mechanisms:

- Anthropic's long-horizon pattern separates an initializer from incremental coding sessions and makes durable files, feature lists, tests, and version control carry state across fresh contexts.
- Its three-agent application harness separates planning, generation, and independent evaluation. The evaluator uses the running application and Playwright rather than accepting the implementer's report.
- Claude Code's sandbox combines filesystem and network boundaries with tool descriptions that tell the model what will work and when escalation is required. Anthropic reports an 84% reduction in permission prompts from this design.
- Managed Agents separates append-only session state, the harness, and the sandbox so workers can move or restart without losing the conversation record.
- Anthropic's MCP code-execution pattern exposes a compact capability index and loads or invokes the long-tail tool surface programmatically; its example reduces loaded tool definitions from roughly 150,000 tokens to about 2,000. This is an illustrative vendor workload.

Why it matters:

- Long-horizon reliability comes from durable external state and clean handoffs, not ever-growing conversation context.
- Independent verification should have a different failure mode from implementation.
- A sandbox must be legible to the model or it creates repeated denied work.

Primary sources:

- <https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents>
- <https://www.anthropic.com/engineering/harness-design-long-running-apps>
- <https://www.anthropic.com/engineering/claude-code-sandboxing>
- <https://www.anthropic.com/engineering/managed-agents>
- <https://www.anthropic.com/engineering/code-execution-with-mcp>

### Devin

Observed mechanisms:

- A declarative blueprint builds a frozen environment snapshot; every session starts from a fresh copy. Initialization, maintenance, executable knowledge, and post-build validation have distinct roles. A failing post-build command prevents the snapshot from becoming active.
- Knowledge is trigger-addressed instead of injected indiscriminately.
- Computer use is a screenshot/action loop tied to browser state. Testing guidance connects code diffs to a test plan and preserves video evidence.
- CDP and Playwright can operate the same authenticated browser state, allowing the agent to switch between semantic automation and visual control.
- Skills, playbooks, and manager/worker separation package repeated work without requiring one giant prompt.

Why it matters:

- Environment fidelity is part of model quality. Missing dependencies often look like model failure.
- Browser verification is most useful when it shares authenticated state and produces reviewable evidence.

Primary sources:

- <https://docs.devin.ai/onboard-devin/environment/blueprints>
- <https://docs.devin.ai/product-guides/knowledge>
- <https://docs.devin.ai/work-with-devin/computer-use>
- <https://docs.devin.ai/work-with-devin/testing-and-video-recordings>

### Pi

Observed mechanisms:

- The default ACI is deliberately small: read, write, edit, and bash. Extensions carry additional behavior.
- Sessions are append-only trees. Compaction appends a summary and retained-tail pointer without deleting older history; branch navigation can summarize the branch being left.
- Compaction keeps tool calls and results atomic, carries cumulative read/modified-file identity, reserves 16,384 tokens for the response by default, and retains a 20,000-token recent tail.
- One-off compaction and branch-summary requests use fresh routing identities and disable cache writes where supported because their prefixes are unlikely to be reused.
- The official subagent extension returns structured results and caps fan-out, concurrency, and output.

Why it matters:

- Minimal model-facing tools can outperform large catalogs by reducing ambiguity.
- Durable source history makes lossy active context recoverable.
- Cache policy should differ by request class; one-shot utility calls should not pay reusable-cache premiums.

Primary sources:

- <https://github.com/earendil-works/pi/tree/main/packages/coding-agent>
- <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md>

### Hermes Agent

Observed mechanisms:

- Context management has two thresholds: normal in-loop compression at 50% using provider-reported usage, and an 85% gateway hygiene fallback for sessions that grew between turns.
- Stable prompt and skill blocks receive provider-native cache breakpoints.
- A bounded hot memory is paired with exact SQLite/FTS5 session retrieval. `session_search` returns actual stored messages rather than a generated summary. Hermes reports roughly 20 ms search and 1 ms scrolling on its implementation.
- Memory writes are duplicate-checked and scanned for injection, exfiltration, backdoor patterns, and invisible Unicode.
- Browser snapshots use accessibility-tree references, named session isolation, and explicit continuations for oversized observations. Real-profile use is consent-gated and disabled by default.

Why it matters:

- The useful hierarchy is immutable trace, indexed retrieval, small hot memory, then active context.
- Proactive compaction and overflow recovery are separate control problems.
- Browser observations need stable semantic references and recoverable full artifacts.

Conflict not to copy:

- Hermes can fall back to dropping middle turns if no compressor is available. Terminus's evidence path must continue to fail closed rather than lose unrecoverable sources.

Primary sources:

- <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/context-compression-and-caching.md>
- <https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/>
- <https://hermes-agent.nousresearch.com/docs/user-guide/features/browser/>

### Prime Agent

Observed mechanisms:

- A persistent IPython environment is the programmatic membrane for context processing, shell/files, tools, and child agents.
- The Continual Harness stores supplemental prompts, skills, subagent definitions, and memories as versioned disk state; refinement snapshots can roll back and cannot rewrite the immutable base prompt.
- A daemon owns sessions over a local socket. Recoverable workers can detach, reattach, and reconstruct from session JSONL plus a kernel snapshot.
- Goals, heartbeats, schedules, retained children, and bounded autonomous work make long-running operation explicit.
- The repository warns that the worker/kernel boundary is lifecycle isolation, not a security sandbox; generated commands execute with the user's authority.

Reported result:

- The authors' 2026-08-24 paper reports ARC-AGI-3 RHAE Best@1 improving from 30% to 95.5% and broad long-context gains. This is recent, author-produced, and not independently replicated here.

Why it matters:

- Programmatic context processing can replace repeated model round trips and giant schema surfaces.
- Harness adaptation should be supplemental, versioned, evaluated, and reversible.
- Terminus can adopt a typed, kernel-confined programmatic layer without copying Prime's unrestricted authority.

Primary sources:

- <https://github.com/PrimeIntellect-ai/prime-agent>
- <https://www.primeintellect.ai/blog/prime-agent>
- <https://arxiv.org/abs/2608.23552>

### Strong adjacent mechanisms

- **SWE-agent:** syntax-linted edits, a 100-line file viewer, concise per-file search results, and explicit empty-output messages demonstrate that ACI shape directly affects agent success. Source: <https://github.com/SWE-agent/SWE-agent/blob/main/docs/background/aci.md>.
- **Aider:** a graph-ranked repository map and model-specific edit formats spend context on structurally relevant symbols rather than alphabetical file dumps. Sources: <https://aider.chat/docs/repomap.html> and <https://aider.chat/docs/more/edit-formats.html>.
- **Factory Droid:** deferred capability loading keeps compact discovery metadata in context and promotes full schemas only when selected. Factory reports 15.1% average estimated input-token reduction for measured MCP-triggering sessions and 50.8% for sessions with 100 or more hidden tools. Its cache-aware router reports lower cost and latency while preserving eight production outcome measures; both are vendor results that need reproduction. Sources: <https://factory.ai/news/deferred-context-engine> and <https://factory.ai/news/model-routing-belongs-in-the-harness>.
- **Cursor cloud agents:** durable Temporal workflows, decoupled loop/machine/conversation state, retry-aware append-only client streaming, prewarmed VMs, and self-healing environments address multi-day reliability. Source: <https://cursor.com/blog/cloud-agent-lessons>.
- **OpenHands:** typed action/observation pairs and immutable events keep tools provider-neutral and replayable. Source: <https://docs.openhands.dev/sdk/arch/sdk>.
- **OpenCode v2:** compaction retains durable earlier messages and constructs active requests from a checkpoint plus recent tail. Source: <https://opencode.ai/v2/docs/compaction/>.

## Cross-system conclusions

The strongest systems converge on a few mechanisms, not a long feature list:

1. A small, model-legible ACI with deterministic error semantics.
2. Immutable or append-only source history plus lossy active-context projection.
3. Stable cached prefixes and request-class-aware cache policy.
4. Deferred loading for long-tail tools, skills, and memory.
5. Reproducible warm environments with exact toolchains.
6. Durable execution state separated from the machine and client.
7. Narrow workers with explicit assignments and independent validation.
8. Browser/computer observations as versioned evidence, not ephemeral pixels.
9. Outcome-linked telemetry: success, verification, recovery, cost, latency, and cache behavior.

No reviewed system publishes sufficient independent evidence to establish universal superiority across quality, cost, latency, security, recovery, and computer use. The right target is a measured frontier, not a permanent marketing rank.

## Terminus current-head audit

### Architecture and agent loop

Observed:

- `mini-services/terminus-control/src/index.ts` owns the durable HTTP/SSE control plane and composes context, provider calls, tool settlement, verification, repair, and completion.
- `mini-services/terminus-control/src/agent/coding-turn-engine.ts` provides the bounded provider/tool loop.
- Current budgets are model-aware; the prior 1,024-token response cap, 32K universal context clamp, 24-step ceiling, and 60-second universal command limit are no longer current-head facts.
- Failed command output, deep file paging, stable context order, task contracts, and adaptive tool activation have current implementations and focused tests.

Open:

- No clean, exact packaged macOS run at this HEAD proves the full loop with a real provider, restart, cancellation, verification, and rendered evidence.
- The control service remains a very large composition root. Correct modules exist, but many product claims still depend on one file and one process.

### Context, compaction, memory, and cache

Observed:

- `packages/context-compiler` builds and persists an inspectable manifest with authority, task, policy, retrieval, evidence gaps, budgets, cache identity, and provider rendering.
- Checkpoints retain contract, criteria, decisions, failures, source versions, effects, and provenance; compaction sources remain content-addressed and recallable.
- Stable-prefix planning, provider cache receipts, predicted-versus-observed cache ratios, and promotion evidence exist.
- The adaptive profile now has deterministic working memory and task/thread-scoped FTS5 session recall over exact stored turn text, with authoritative artifact hydration, a bounded scan fallback, current-turn exclusion, and restart/migration/cascade coverage. The permanent minimal profile remains the control arm.
- The model-facing recall tool can browse and read immutable compaction sources by hash, offset, and continuation without copying the full source into active context.
- Recall telemetry records cache hits, misses, evictions, bytes avoided, source failures, selected-turn yield, retrieval method, and latency.
- Progressive capability discovery can defer the long-tail tool surface. An opt-in, in-memory observation contract now records tokenizer-supplied compact-catalog cost, initial active/deferred full-schema cost, discovery attempts, activation selection error, caller-supplied activation latency, active-set identity, and final active-schema cost without changing model-visible outcomes or the default path.

Open:

- Durable semantic memory correctly remains disabled because its precision and harm gate has not passed.
- Exact recall is proven for scope, source integrity, bounded failure, restart, and migration behavior, but not yet for comparative long-horizon task quality or stale-history harm.
- Provider cache benefit is accounted for but not proven on a paired current-head live cohort.

### Tools and ACI

Observed:

- The always-on coding surface is `read`, `patch`, `write`, `exec`, `exec_poll`, `grep`, and `glob`; adaptive adds `inspect` and `recall`. Recall includes bounded session search plus exact compaction-source browse/read. `web_fetch` is discoverable and activatable.
- Outputs carry explicit truncation and continuations instead of silent loss.
- Workspace mutations and process/network effects route through the kernel boundary.
- Tool-call corrections are returned to the model as durable error results rather than ending the turn.
- Recall discovery SQL is confined to the approved task-runtime repository boundary rather than the agent layer.

Open:

- Model-family-specific ACI selection is limited. Terminus has a canonical tool contract but has not shown that each model receives its best editing/search representation.
- Tool-schema deferral has source support and a deterministic measurement contract, but the observation path is not enabled in production and no paired token/selection-noise cohort has run.
- The process-wide scout implementation is deliberately disabled because its child tool path does not yet use the normal durable settlement boundary.

### Providers, routing, and economics

Observed:

- OpenAI, Anthropic, Google, local, and Zen renderers compile late from canonical context and retain native continuation/cache semantics where implemented.
- Provider usage, cached input, cache writes, reasoning, tool schema tokens, and computed cost reach durable records.
- A strict Artificial Analysis Coding Agent Index v1.4 contract now rejects incomplete matrices, wrong model identities, missing receipts, unresolved image digests, duplicate attempts, missing independent verification, and absent reward-hacking review.
- Current compaction summarization uses an empty breakpoint set. Anthropic therefore emits no explicit cache-control marker for that one-shot request, matching the intended policy.

Open:

- The 978-attempt live campaign has not been run from a clean exact harness revision.
- Router logic is not promoted. Cache-aware switching must price the lost warm prefix and preserve provider-native replay before it can be enabled.
- Terminus has no canonical request-class/cache-disposition field. OpenAI Responses and Zen still emit a `prompt_cache_key` for the one-shot compaction request, while a direct-executor `promptCacheKey` option is not forwarded. Removing the key blindly would conflate cache affinity with billed cache writes; the fix needs provider-specific first-party semantics, recorded attempt metadata, and a long-turn cache regression cohort.
- Current uncommitted provider-account changes are not release evidence.

### Delegation and long-horizon execution

Observed:

- Typed delegation budgets, authorities, transcripts, provider-step accounting, durable task/delegation tables, worktree ledgers, scheduler policies, and independent reviewer contracts exist.
- Parent and child authority can be represented without granting writes to read-only scouts.
- Checkpoint and restart-reconciliation paths exist for tasks and turns.

Open:

- There is no trusted kernel delegation dispatch RPC. The public durable delegation adapter fails closed.
- The in-process scout is hard-disabled; enabling it as-is would bypass normal child tool settlement and contaminate proof.
- Job durability and multi-process recovery remain experimental in `maturity.yaml`.

### Verification and completion

Observed:

- Verification is a typed invalidating DAG. Completion proposals do not become completion until evidence admission succeeds.
- Timeouts and environment identity were repaired after the 2026-08-29 audit; the kernel instance identifier no longer poisons stable environment identity.
- The AA campaign requires independent verification and terminal-bench reward-hacking review.

Open:

- Current-head live false-completion and repair rates are unknown.
- Verification UX in the rendered clients is not yet proven comprehensible under failure, repair, and blocked states.

### Sandbox, security, and computer use

Observed:

- The Rust kernel owns filesystem, patch, process, job, network, secret, artifact, policy, and sandbox effects over a private transport.
- macOS and Linux sandbox implementations have focused enforcement code and security workflows.
- Governed computer-use coordinators define fused observations, semantic target/version checks, lease fencing, takeover, DLP, ambiguous-submit reconciliation, and receipt verification.

Open:

- Computer use is coordinator-only. Public execution routes return 503 because there is no trusted kernel-backed browser or desktop adapter.
- Windows native sandbox, microVM execution, and extension-runtime isolation remain unproven or unavailable.
- Current candidate-bound macOS/Linux enforcement evidence is absent.

### Persistence, recovery, and observability

Observed:

- SQLite events, content-addressed artifacts, checkpoints, provider attempts, tool calls, evidence bundles, lease fencing, and SSE cursors create a substantial recovery substrate.
- Cache, provider, tool, verification, and task telemetry types exist.

Open:

- The default observability backend is in-memory; no operational backend closes the loop on outcome, routing, cache, or recovery policies.
- Retry-aware client stream rewind, multi-day worker recovery, and exact packaged-process interruption have not been demonstrated at this HEAD.

### UI and UX

Observed:

- The TUI is the primary full-screen runtime surface. The Electron desktop is a projection of the control plane rather than a separate agent loop.
- Desktop source has substantial current work for task presentation, interventions, progress, follow-ups, provider accounts, and active-thread UX.
- The exact committed source stack launched a release-mode kernel, migrated a fresh isolated database through migration 30, reached control-plane health, opened Electron, and rendered the empty task surface. The production renderer build also passed after transforming 2,365 modules.
- The rendered empty state is visually quiet and coherent: task rail, project/activity choice, central task composer, project picker, model/effort identity, settings, and connection state fit in one window without dashboard chrome.

Open:

- The main checkout's newer desktop work is dirty, so those in-progress changes are not attributable to this clean baseline.
- The fresh exact-head visual pass covers only the ready empty state; populated, loading, error, approval, repair, interruption, and recovery states remain uninspected.
- Computer use, context, effects, evidence, agents, terminal custody, and cache/cost identity are not yet one quiet mission-control experience.
- The captured macOS accessibility tree exposed the window and application menus but not the React controls visible in the renderer. Keyboard and assistive-technology reachability therefore remain unproven.
- The source launch logged that CSP `frame-ancestors` is ignored when delivered through a meta tag. The renderer also displayed `Connected 1 provider from OpenCode Zen`, but no external inference was exercised, so the user-facing access claim is not live proof.

### CI and evals

Observed:

- CI covers type/lint/unit, E2E, security, fault/fuzz/soak, release, platform, and sandbox-evidence paths.
- Runtime-backed fixture evaluation now exercises the provider/control/kernel tool loop.
- The strict AA campaign code and its focused tests pass locally.
- On an exact source-tree validation checkout, `just check`, `just standalone-check`, `just e2e`, and `just eval-smoke` pass; the final control-plane suite reports 663 passing tests. `just codegen-check` passed at the immediately preceding generated-tree checkpoint. Final reruns are currently blocked before generation by Buf's external `resource_exhausted: too many requests` response; the capability-only commit changes no generated input and the failed reruns left all generated paths unchanged.

Open:

- Fixture-only green is not live-provider or release evidence.
- Live cohorts are dispatch-gated and require credentials, runner images, provider receipts, and a clean exact revision.
- `maturity.yaml` correctly declares that no subsystem is production.
- The exact committed desktop suite currently reports 852 passing, 6 failing, and 11 skipped tests. All six failures are storage-denial mocks that target `Storage.prototype` rather than the jsdom `window.localStorage` instance; equivalent test-only repairs exist in the unrelated dirty desktop work but are not evidence for this baseline.

## Design decisions to challenge

### Breadth before a closed product loop

Terminus has more governance substrate than product proof. New subsystem work should pause whenever it does not improve the exact provider-to-evidence path or an acceptance gate on that path.

### Harness behavior that models can now own

The harness should deterministically enforce authority, durability, budgets, idempotency, cache identity, and verification admission. Search strategy, test selection, and ordinary workflow choice should increasingly be model-controlled tools when held-out evidence shows the model is reliable. Cursor's experience and Anthropic's harness work both support reducing brittle orchestration as models improve.

### Permanent minimal as product default

Minimal is valuable as a control arm, not necessarily the final everyday product. Adaptive should become the default only after the paired promotion gate proves non-inferior reliability and better verified quality, cost, or latency. That decision must not be made from intuition.

### Routing before cache-aware evidence

A cheaper model is not cheaper if switching discards a large warm prefix or provider-native reasoning state. Routing must observe cache state, stall signals, task phase, and downstream verification outcome. Until then, a stable single model is the safer economic policy.

### Programmatic orchestration without a bypass

Prime and Anthropic show the power of code-mediated context/tool orchestration. Terminus should add a typed programmatic layer only if every filesystem, process, network, secret, and computer action still crosses the kernel. A persistent unrestricted Python or shell process would erase Terminus's core advantage.

### Automatic verification everywhere

Independent verification is essential for mutation and completion claims. It should not force expensive generic checks after read-only questions or duplicate checks the agent already ran unless the evidence is stale, insufficient, or risk-triggered.

## Dependency-ordered execution roadmap

Statuses describe this exact checkout on 2026-08-30.

### Gate 0: honest measurement substrate — implemented locally, live run open

Implemented:

- strict same-model AA Coding Agent Index v1.4 contract;
- full 978-cell deterministic/resumable matrix;
- exact runner-source and harness-revision checks;
- provider receipt, image digest, independent verification, full telemetry, and reward-hacking gates;
- runtime-backed fixture smoke through provider, control plane, kernel, and tool settlement;
- paired promotion infrastructure and cache/cost analysis modules.

Acceptance still open:

- freeze a clean harness revision and runner images;
- execute all live attempts with external receipts;
- publish the complete immutable run catalog and independent verifier artifacts;
- compare against runnable competitor harnesses under identical model, task, budget, and environment.

### Gate 1: exact everyday coding loop — highest priority

Work:

1. Freeze the current provider/account changes into reviewable commits after their owner completes them.
2. Run a real adaptive coding task through the exact current checkout.
3. Exercise failing command output, deep file read, patch, rerun, verification, final evidence, interruption, restart, and SSE resume.
4. Build and launch the exact packaged macOS artifact and repeat the task from the rendered app.
5. Bind source, build, runtime, provider, model, effort, profile, prompt/tool schema, sandbox, and environment identities into the evidence bundle.

Acceptance:

- no lost provider/tool/result item;
- cancellation stops paid work and child processes;
- restart resumes or explicitly reconciles every ambiguous effect;
- all required acceptance criteria are independently admitted;
- the desktop shows the same durable truth as the API and TUI;
- the complete desktop test suite passes and the rendered controls are present in the macOS accessibility tree;
- `just check`, `just standalone-check`, `just codegen-check`, E2E, package, and applicable security gates pass on the frozen revision.

### Gate 2: context and ACI efficiency — implementation started, promotion evidence open

Implemented locally:

1. Task/thread-scoped FTS5 discovery over exact turn text, with immutable artifact authority, bounded scan fallback, Unicode tokenizer parity, and bounded worst-case behavior.
2. Exact compaction-source browse/read actions in the model-facing recall tool.
3. Recall-cache hits, misses, evictions, bytes avoided, source failures, selected-turn yield, retrieval method, and latency telemetry.
4. Opt-in capability-disclosure observations for compact-catalog cost, initial active/deferred schema cost, discovery attempts, activation selection error, activation latency, active-set hash, and final active-schema cost. The observation is in-memory and is not yet wired into production events.

Still open:

4. Run the paired deferred-capability cohort and join the observation snapshot to provider cache ratio, latency, and verified solve rate.
5. Evaluate model-family-specific edit/search formats against the canonical ACI.
6. Classify one-shot utility requests so they do not pay reusable cache-write costs.

Acceptance:

- adaptive is non-inferior on verified solve rate and stale-history harm;
- total input tokens or time to first useful action improves with confidence intervals;
- no cross-task/thread/workspace retrieval;
- exact sources remain reachable after compaction and restart;
- no default promotion until the declared eval and security cohort passes.

### Gate 3: durable scoped delegation

Work:

1. Add a kernel delegation dispatch and recovery protocol with identity-bound receipts.
2. Model child agents as durable child turns/jobs, not hidden calls inside the parent turn.
3. Route every child tool call through ordinary proposal, approval, kernel effect, settlement, transcript, and artifact records.
4. Start with read-only scouts and independent reviewers. Writers require separate worktrees, non-overlapping ownership, merge admission, and bounded fan-out.
5. Include child tokens, cache, cost, time, failures, citations, and verifier value in the parent budget and evidence.

Acceptance:

- kill/restart recovery with no duplicate provider call or effect;
- child authority cannot exceed parent authority;
- parent compaction cannot orphan live children;
- parallel workers never share a writable checkout;
- delegation runs only when a held-out value-of-information policy beats the single-agent control.

### Gate 4: governed browser and computer use

Work:

1. Implement a kernel-backed CDP/Playwright browser adapter first; add desktop accessibility/input only after browser semantics are reliable.
2. Fuse screenshot, DOM, accessibility tree, viewport, URL, and source identity into immutable observations.
3. Require semantic target plus observation version; reject stale, ambiguous, occluded, or policy-ineligible actions.
4. Preserve authenticated browser custody without exposing raw credentials.
5. Add explicit consequence classes, takeover fencing, DLP, ambiguous-submit reconciliation, screen/video artifacts, and outcome receipts.

Acceptance:

- adversarial pages cannot silently redirect authority or exfiltrate protected data;
- stale-snapshot, coordinate drift, occlusion, duplicate submit, navigation race, and human-takeover tests pass;
- UI tasks are verified against the rendered result, not build success;
- fixed-budget browser cohorts improve verified UI completion without unacceptable policy failures.

### Gate 5: durable environments and recovery

Work:

1. Define versioned local/cloud environment blueprints with post-build validation.
2. Add warm snapshot, hibernate, resume, fork, and self-diagnosis interfaces without coupling conversation state to a machine.
3. Make provider outage, worker crash, client disconnect, process timeout, and host restart first-class fault cohorts.
4. Implement reference-aware session/artifact retention and dry-run cleanup.

Acceptance:

- exact environment digest and resolved image/snapshot identity in every run;
- repeatable environment build with nonzero validation blocking promotion;
- declared recovery SLO demonstrated by fault injection;
- no active or evidence-referenced artifact is pruned.

### Gate 6: mission-control UX

Work:

1. Keep conversation primary and add one coherent inspector for Run, Diff, Terminal, Context, Effects, Evidence, Agents, and Computer.
2. Surface exact source/build/runtime/provider/model/profile/sandbox identity, cost/cache/TTFT, truncation continuations, approvals, and blocked gates.
3. Make steer, queue, interrupt, take over, retry, fork, handoff, archive, and review reversible and state-aware.
4. Use native macOS windows, menus, shortcuts, notifications, and accessibility; keep advanced machinery collapsed until relevant.

Acceptance:

- fresh visual inspection of loading, empty, populated, approval, error, repair, interruption, recovery, and completion states;
- no UI state contradicts the durable API/event log;
- representative users can identify what is running, what changed, what is blocked, what authority it has, and what evidence supports completion.

### Gate 7: routing and continual improvement

Work:

1. Route only at job boundaries or cache-economically justified phase changes.
2. Use task phase, cache warmth, stall/repetition, tool failures, verifier results, and remaining work as features.
3. Store routing decisions and delayed outcomes for offline policy evaluation.
4. Allow refinement only in versioned supplemental prompts, skills, tool cards, or routing policies; never self-edit kernel policy or immutable authority.
5. Require holdout, multiple-comparison correction, rollback, tenant scoping, and anti-reward-hacking review.

Acceptance:

- non-inferior verified quality with lower cost or latency per verified solve;
- no security or recovery regression;
- every promoted policy is reproducible, attributable, and reversible.

## Completed implementation slice

The first repository-owned Gate 2 tranche is complete in five logical commits:

- `adfeb528`: task/thread-scoped FTS5 recall, authoritative artifact hydration, bounded fallback, exact compaction-source browse/read, telemetry, and migration/recovery tests;
- `09e85536`: moved recall SQL behind the approved task-runtime repository boundary and fixed strict error/timing behavior;
- `fd10521f`: made read-only tool permission labels exhaustive for the expanded inspect/recall surface;
- `8ae792ee`: removed an obsolete Harbor type suppression that blocked clean current-tree validation;
- `c8768b5d`: added bounded, opt-in, non-model-visible capability-disclosure observations after independent adversarial review.

The slice does not change the minimal profile, enable semantic memory, or claim adaptive promotion. Independent adversarial review found no remaining priority-one or priority-two recall issue after Unicode/FTS parity and worst-case bounds were hardened.

The highest-priority next product action is Gate 1's frozen real-provider and packaged-macOS proof. The next Gate 2 action is wiring the capability snapshot into a versioned attempt record and running a paired adaptive-versus-control cohort. That wiring crosses the currently dirty control root and is intentionally deferred until its owner can isolate it. Neither adaptive disclosure nor any cache policy should be promoted from fixture-only evidence.

## Claim and evidence gaps

| Claim | Current evidence | Confidence | Required proof |
| --- | --- | --- | --- |
| Terminus contracts are stronger than competitors' published boundaries. | Current source and SPEC show non-bypassable intended effect, manifest, scope, and evidence contracts. | Medium-high | Adversarial exact-path tests for every effect and packaged artifact. |
| Current adaptive mode improves coding quality. | Runtime fixture and focused tests; no paired live cohort. | Low | Same-model randomized held-out minimal vs adaptive cohort. |
| Cache planning lowers real cost and latency. | Durable predicted/observed accounting exists. | Low | Provider receipts across paired long sessions with stable-prefix diagnostics. |
| Exact recall improves long-horizon consistency. | Scoped implementation and source integrity tests. | Medium for safety, low for quality | Multi-turn held-out quality, stale-history harm, latency, and token cohort. |
| Scoped delegation improves difficult tasks. | Typed runner and accounting tests; live path disabled. | Low | Durable kernel-backed child cohort against single-agent control. |
| Governed computer use is safer and more reliable. | Coordinator contracts and tests only. | Low | Real browser/desktop adapter plus hostile-page and UI benchmark evidence. |
| Terminus is faster or cheaper than Codex/Claude/Devin. | No comparable current-head runs. | Unknown | Frozen external live campaign with identical model/environment/authority. |
| Terminus is production-ready. | `maturity.yaml` says no. | High that it is not yet established | Candidate-bound release, security, platform, recovery, and product evidence. |

## Non-goals and guardrails

- Do not optimize prompts or tool semantics for public benchmark fixtures.
- Do not enable durable semantic memory, routing, delegation, or computer use by default without their promotion gates.
- Do not flatten provider-native reasoning, continuation, cache, or computer-use state into generic chat messages.
- Do not introduce a programmatic tool layer that bypasses the Rust kernel.
- Do not treat compilation, fixture evals, CI dispatch, or an active process as product proof.
- Do not touch production, push, merge, publish, or mutate identity-bearing external systems without explicit authorization.
- Do not absorb the current unrelated dirty desktop/provider work into this program's commits.

## Current verification record

- Focused AA campaign and strict scoring tests: 14 passed.
- Focused recall, compaction, migration, recall-tool, and profile tests: 126 passed.
- Focused capability-disclosure tests: 10 passed, 0 failed, 42 assertions; independent re-review found no remaining priority-one or priority-two issue.
- Full control-plane suite on the final exact committed tree: 663 passed, 0 failed, 2,438 assertions.
- Exact source-tree validation: `just check`, `just standalone-check`, and `just e2e` passed. E2E covered the control-writer fence, restart/recovery, SSE reconnect, seven ARP lifecycle checks, and six complete-turn integration checks.
- `just codegen-check` passed on the exact pre-observation generated tree. Two final reruns stopped before generation because Buf returned `resource_exhausted: too many requests`; generated paths remain byte-clean against `HEAD` and the final commit changes only hand-written TypeScript/tests.
- `just eval-smoke` passed its minimal, adaptive, and adaptive-inspect runtime fixtures. These results are explicitly fixture-only, not live-provider evidence.
- Exact desktop production build passed. The isolated source stack reached kernel/control health and rendered the empty Electron task surface; no real provider turn or signed/package artifact was exercised.
- Exact committed desktop tests: 852 passed, 6 failed, 11 skipped. The six storage-denial mock failures remain an open Gate 1 baseline issue, not a green result.
- Current repository state and sixteen local implementation commits were inspected directly; task-owned commits exclude the unrelated dirty desktop/provider/account work.
- Competitive claims above were checked against current first-party sources as of the research cutoff.
- Live provider, packaged/signed macOS, full AA campaign, current-head release, governed computer use, populated/error/recovery desktop states, and complete accessibility evidence remain open.

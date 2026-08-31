# Terminus Pareto-leading harness: research, audit, and execution roadmap

Date: 2026-08-30

Research cutoff: 2026-08-30

Repository observed: `/private/tmp/terminus-pareto-integration.7PE45z/worktree`, exact exercised code revision `8a045eb4edb9996993586f398b7713dbbb41ef72`

Evidence state: the integration head contains the current `main` runtime/desktop work and retains the complete histories of `codex/harness-efficiency-20260830`, `codex/security-harness-research-20260830`, and `codex/long-horizon-context-engine-20260830`; all three named branch tips are ancestors of the observed revision. The exact live runtime and restart below were exercised at `8a045eb4`; the rendered desktop inspection remains bound to `030df02b`. The final report-only commit will be ahead of the exercised code, but changes no executable behavior. This is local integration and runtime evidence, not a pushed, signed, packaged, released, or independently reproduced candidate.

## Direct answer

Terminus is not proven to be the best coding harness or globally Pareto-leading. It does have a credible route to a measured Pareto frontier.

Its strongest differentiators are already real code: a Rust effect boundary, immutable context manifests, task and scope contracts, content-addressed artifacts, durable semantic events, cache accounting, typed verification, and evidence-gated completion. Competitors are generally stronger today on one or more complete product paths: Codex on the integrated macOS task surface and efficient model-native loop; Claude Code on a disciplined tool loop, sandbox usability, and long-horizon practices; Devin on reproducible cloud environments and browser-backed verification; Pi on minimalism and inspectable branchable sessions; Hermes on exact session retrieval and browser ACI; Prime Agent on programmatic orchestration and recoverable persistent execution.

The integration now closes one narrow live-provider path through an exact source-built kernel: deterministic workspace activation, real model inference, kernel-mediated reads/write/exec, an exact file edit, successful verification, committed completion evidence, truthful turn-scoped evidence projection, and restart read-back succeeded at revision `8a045eb4`. The source desktop was separately rendered and inspected at ancestor `030df02b`. That is meaningful operational evidence. It is one synthetic local task with one free model, not comparative quality, cost, latency, cancellation, signed/package, or production evidence.

The highest-impact strategy is therefore not to add every competitor feature. It is to keep closing and measuring the complete path:

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
- At exact kernel build digest `8a045eb4edb9996993586f398b7713dbbb41ef72`, live task `39a1cc03-09ab-467c-af43-db2974feb0e8` and turn `595e9604-0558-4c86-b772-eb2a84e00208` traversed provider, tool, kernel, verification, completion, persistence, and restart boundaries successfully. The task and turn are `COMPLETED`; the task phase is `COMPLETE`.

Open:

- No signed or packaged macOS run at this revision proves the same live loop through the rendered desktop. Cancellation, ambiguous provider submission, paid-model billing, and host-restart behavior also remain open.
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
- Adaptive compaction is an experiment, not the default. The default remains the exact fixed-byte control assignment: a 384,000-byte loader/trigger, 96,000-byte retained tail, and 400,000-character summary chunks. `TERMINUS_EXPERIMENTAL_ADAPTIVE_COMPACTION=1` enables the versioned adaptive assignment; invalid values fail, and unavailable budgets or degraded tokenizer calibration fall back to the exact control behavior. Requested and effective assignments are recorded, while obligation anchors, source lineage, atomic tool-call/result retention, and retry suppression remain enforced.
- ADR-0055 remains proposed. Its implementation and measurements are candidate evidence, not an adopted default-policy decision.
- Independent review found that the fixed-byte episode loader could fetch and decode one older artifact after newer unique content had already exhausted the window. `1ce003dc` now stops before that out-of-window read, with a regression test that observes artifact access.

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
- Before workspace activation, the model now sees a capability schema whose only valid action is `activate_workspace`; catalog search/list actions become valid only after activation. A prior exact live attempt used the broader initial schema, searched an empty catalog, and refused the task because it inferred that workspace tools did not exist. The staged schema and guard make that invalid transition unrepresentable while preserving the model's direct-answer choice.
- Independent review found that one provider response could activate the workspace and then have another call checked against schemas widened after the response was generated. `973ba1a` snapshots the exact schemas sent for each attempt and validates every returned call against that same-attempt declaration; expanded schemas become valid only on the next attempt.
- Final independent review found that successful capability settlement and its activation snapshot were split commits: a crash could preserve the successful tool result and episodes without the transition replay needs. `8a045eb4` uses `emitAtomicBatch` so the tool result, episodes, and capability transition event commit or roll back together. Rollback and replay tests cover failed settlement and exact post-action recovery.
- Settled canonical tool-result envelopes are unwrapped consistently for patches, command output, and command state. The successful live verification command consequently reached the next provider request as `last_command.exitCode: 0` rather than `null`.

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
- Persisted metrics for the exact live task report five steps, 25,584 input tokens, 16,000 cached input tokens, 375 output tokens, and zero computed cost under the provider's free-model contract.

Open:

- The 978-attempt live campaign has not been run from a clean exact harness revision.
- Router logic is not promoted. Cache-aware switching must price the lost warm prefix and preserve provider-native replay before it can be enabled.
- Terminus has no canonical request-class/cache-disposition field. OpenAI Responses and Zen still emit a `prompt_cache_key` for the one-shot compaction request, while a direct-executor `promptCacheKey` option is not forwarded. Removing the key blindly would conflate cache affinity with billed cache writes; the fix needs provider-specific first-party semantics, recorded attempt metadata, and a long-turn cache regression cohort.
- One free-model task does not establish provider conformance, economic superiority, or the stability of cache reuse across long sessions.

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
- The exact live edit produced verification plan `2df47d0b-6dde-4125-8a30-7f21c1d85b9d`, a passing verification result, a dirty revision bound to workspace bytes, and committed completion record `completion:39a1cc03-09ab-467c-af43-db2974feb0e8`. The file bytes were exactly `status=FIXED\n`, and the workspace's `bun verify.ts` exited zero.
- Evidence bundles exposed on task reads are now explicitly labeled `scope: "turn"`, include `turn_id`, and use `turn_outcome` and `bundle_state` aliases. Legacy wire fields remain for v1 compatibility but no longer imply that a completed turn bundle by itself admitted task completion.
- Independent review found that a turn bundle could include stale verification-result IDs from other plans on the same task. `973ba1a` binds evidence lookup to the turn's selected verification plan and records no verification IDs when that turn has no plan.

Open:

- Current-head live false-completion and repair rates are unknown.
- Verification UX in the rendered clients is not yet proven comprehensible under failure, repair, and blocked states.

### Sandbox, security, and computer use

Observed:

- The Rust kernel owns filesystem, patch, process, job, network, secret, artifact, policy, and sandbox effects over a private transport.
- macOS and Linux sandbox implementations have focused enforcement code and security workflows.
- Governed computer-use coordinators define fused observations, semantic target/version checks, lease fencing, takeover, DLP, ambiguous-submit reconciliation, and receipt verification.
- Native standalone execution remains on `secure-local-default`. The broader `workspace-development` policy cannot be selected by a configured bearer token; it requires a signed, task/workspace-bound capability claim, exact whole-workspace scope, and the distinct `workspace-development-isolated` sandbox profile. That isolated profile is deliberately typed unavailable until a real container or microVM implementation and its security/recovery gates exist.
- ADR-0054 remains proposed; the dormant broader binding is not release authorization.

Open:

- Computer use is coordinator-only. Public execution routes return 503 because there is no trusted kernel-backed browser or desktop adapter.
- Broad workspace-development execution, Windows native sandboxing, microVM execution, and extension-runtime isolation remain unproven or unavailable.
- Current candidate-bound macOS/Linux enforcement evidence is absent.

### Persistence, recovery, and observability

Observed:

- SQLite events, content-addressed artifacts, checkpoints, provider attempts, tool calls, evidence bundles, lease fencing, and SSE cursors create a substantial recovery substrate.
- Cache, provider, tool, verification, and task telemetry types exist.
- Independent review found that a restarted turn reconstructed neither lazy workspace activation nor optional capability activation. `973ba1a` recovers both only from committed turn-scoped activation/deactivation events, ignores malformed payloads, and drops capability IDs the current binary no longer admits.
- After the exact live task completed, immediate restart attempts failed closed while the prior writer lease remained valid. After lease expiry, restart recovery acquired a new fenced writer lease, replayed six tasks, and read back the exact terminal task, turn, matching committed turn-scoped evidence, dirty revision binding, and kernel digest `8a045eb4edb9996993586f398b7713dbbb41ef72`.

Open:

- The default observability backend is in-memory; no operational backend closes the loop on outcome, routing, cache, or recovery policies.
- Retry-aware client stream rewind, multi-day worker recovery, host restart, and packaged-process interruption have not been demonstrated at this revision. The observed restart was a local control/kernel process restart.

### UI and UX

Observed:

- The TUI is the primary full-screen runtime surface. The Electron desktop is a projection of the control plane rather than a separate agent loop.
- Integrated desktop source includes the focused active-workflow changes for task presentation, interventions, progress, follow-ups, provider accounts, and active-thread UX.
- The exact `030df02b` desktop source launched with isolated user data against the exercised control plane. Onboarding rendered, **Skip setup** worked, and the main composer rendered.
- The completed live task rendered in the desktop with **Done**, **Work completed**, **1/1 checks passed**, grouped activity, and the verification response. This is rendered read-back of the same durable task, not a separately inferred UI success.
- The renderer storage-denial mocks now install a deterministic browser-shaped `Storage` implementation instead of depending on Node's process-global `localStorage`. The complete desktop suite passes 890 tests with 11 intentionally skipped, and the Electron production build passes.

Open:

- Loading, error, approval, repair, interruption, recovery, steer, and cancellation states remain uninspected in the exact desktop.
- Computer use, context, effects, evidence, agents, terminal custody, and cache/cost identity are not yet one quiet mission-control experience.
- System Events accessibility inspection exposed only window chrome, not the visible React controls. Keyboard and assistive-technology reachability therefore remain unproven.
- The completed provider task was read back through the desktop, but task initiation and tool interaction from the renderer were not exercised. The source launch also logged that CSP `frame-ancestors` is ignored when delivered through a meta tag.

### CI and evals

Observed:

- CI covers type/lint/unit, E2E, security, fault/fuzz/soak, release, platform, and sandbox-evidence paths.
- Runtime-backed fixture evaluation now exercises the provider/control/kernel tool loop.
- The strict AA campaign code and its focused tests pass locally.
- At exact exercised code head `8a045eb4`, `just check`, `just standalone-check`, `just e2e`, `just security`, `just codegen-check`, and all three `just eval-smoke` fixture cohorts passed. The focused review-fix suite passed 122/122, covering fixed-window reads, per-attempt schema declarations, plan-scoped evidence IDs, activation recovery, atomic capability settlement, rollback, and replay. The complete desktop suite and Electron production build passed at ancestor `030df02b`; the exact live task exercises the later integrated workspace, verification, completion, and restart path.

Open:

- Fixture-only green is not live-provider or release evidence.
- Live cohorts are dispatch-gated and require credentials, runner images, provider receipts, and a clean exact revision.
- `maturity.yaml` correctly declares that no subsystem is production.
- `just codegen-check` first identified honest generated inventory drift after the earlier integrated tests changed; `just codegen` refreshed that inventory in `ac1af9fb`, and the final exact-head deterministic check at `8a045eb4` passes without drift.

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

### Gate 0: honest measurement substrate — implemented locally, comparative campaign open

Implemented:

- strict same-model AA Coding Agent Index v1.4 contract;
- full 978-cell deterministic/resumable matrix;
- exact runner-source and harness-revision checks;
- provider receipt, image digest, independent verification, full telemetry, and reward-hacking gates;
- runtime-backed fixture smoke through provider, control plane, kernel, and tool settlement;
- paired promotion infrastructure and cache/cost analysis modules.
- one exact live-provider minimal-profile task with durable attempts, token/cache accounting, tool settlements, verification, completion, evidence, and restart read-back.

Acceptance still open:

- freeze a clean harness revision and runner images;
- execute all live attempts with external receipts;
- publish the complete immutable run catalog and independent verifier artifacts;
- compare against runnable competitor harnesses under identical model, task, budget, and environment.

### Gate 1: exact everyday coding loop — partial local proof, highest priority

Observed in the exact `8a045eb4` runtime and `030df02b` desktop inspection:

1. The three research branches and current main runtime/desktop work are integrated in reviewable history.
2. A real minimal-profile provider task used deterministic activation, reads, an exact write, exec verification, admitted completion, turn-scoped evidence, and fail-closed process restart recovery.
3. Source, runtime build digest, provider/model/profile, context manifests, attempts, tool calls, workspace revision, environment digest, verification plan, and completion record were retained.
4. Exact `030df02b` source desktop onboarding, setup skip, composer, and the completed task/evidence surface rendered against the same control plane.

Still open:

1. Exercise a deliberate failing command, repair, deep paged read, cancellation, ambiguous submission, SSE rewind, and host interruption in one candidate-bound task.
2. Build and launch the exact signed/packaged macOS artifact, then initiate, steer, cancel, and repeat the task from the rendered app.
3. Run the adaptive profile only as an experimental cohort against the fixed control; do not infer adaptive quality from the minimal-profile live run.

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
5. Obligation-anchored, budget-derived compaction behind `TERMINUS_EXPERIMENTAL_ADAPTIVE_COMPACTION=1`, with the exact fixed-byte assignment retained as the default/control and as the fallback for degraded or unavailable calibration.

Still open:

1. Run the paired deferred-capability and compaction cohorts and join the observation snapshot to provider cache ratio, latency, verified solve rate, obligation retention, and stale-history harm.
2. Evaluate model-family-specific edit/search formats against the canonical ACI.
3. Classify one-shot utility requests so they do not pay reusable cache-write costs.

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

The integration retains the three named research histories and combines four reviewable tranches:

- **Harness efficiency:** exact prompt-cache plan forwarding, cold-write accounting, dirty-workspace revision binding, complete path batching, optional unavailable probes, typed terminal policy denials, and runtime-backed eval settlement.
- **Security harness:** signed capability binding for broad policy, exact whole-workspace scope, constrained sandbox environment forwarding, deterministic Linux wrapper proof, and a fail-closed `workspace-development-isolated` promotion boundary. Native standalone execution remains on the curated default.
- **Long-horizon context:** model-budget-aware obligation anchoring, atomic summary/tail fitting, source lineage, retry suppression, requested/effective assignment telemetry, and an explicit experimental gate that preserves the fixed-byte default and degraded fallback.
- **Combined-loop hardening:** deterministic pre-workspace activation (`b77c170d`), canonical exec-observation decoding (`0aec7442`), honest turn-scoped evidence projection (`e934aeab`), deterministic renderer storage mocks (`982ed348`), an explicit activation-schema invariant (`94fa2c8d`), refreshed generated test inventory (`ac1af9fb`), fixed-window artifact access (`1ce003dc`), turn-bound evidence/schema/activation recovery (`973ba1a`), and atomic capability result/episode/transition settlement (`8a045eb4`).

The earlier Gate 2 recall tranche also remains present: task/thread-scoped FTS5 recall, authoritative artifact hydration, bounded fallback, exact compaction-source browse/read, telemetry, migration/recovery coverage, exhaustive read-only permission labels, and opt-in non-model-visible capability-disclosure observations.

No tranche promotes adaptive compaction, semantic memory, routing, delegation, broad native execution, or computer use. The first live attempt after exec-observation repair exposed a real initial-capability failure: the model could search/list before activation, found no workspace tools, and refused. The staged activation contract fixed that mechanism; the subsequent exact task succeeded. This is stronger evidence than a fixture, but it is still a single-task repair observation and not a general promotion result.

After the final atomic-settlement repair, independent review found no remaining priority-zero, priority-one, or priority-two issue in the reviewed integration slice. That is a bounded code-review result, not proof that no defect exists elsewhere in the harness.

The highest-priority next action is to repeat the provider-to-evidence loop from the signed/packaged macOS product, including UI initiation, cancellation, interruption, repair, approval/error states, and accessibility. In parallel, the next Gate 2 action is a paired minimal-versus-adaptive cohort with identical model, task, environment, authority, and budget. Neither adaptive context policy nor cache/routing policy should be promoted from the current evidence.

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
- Do not touch production, push, publish, or mutate identity-bearing external systems without explicit authorization.
- Do not treat a local integration merge, synthetic live task, source Electron build, or clean generated-tree diff as release evidence.

## Current verification record

- Focused AA campaign and strict scoring tests: 14 passed.
- Focused recall, compaction, migration, recall-tool, and profile tests: 126 passed.
- Focused capability-disclosure tests: 10 passed, 0 failed, 42 assertions; independent re-review found no remaining priority-one or priority-two issue.
- At exact exercised code head `8a045eb4`, combined-tree validation passed `just check`, `just standalone-check`, `just e2e`, `just security`, and `just codegen-check`. Focused provider core/OpenAI/Anthropic tests passed 73/73; focused control/context/provider-account/recovery tests passed 145/145; Rust provider-account tests passed 7/7.
- The three `just eval-smoke` fixture cohorts passed: minimal used 5 attempts/4 settlements, adaptive used 4/3, and adaptive-plus-inspect used 5/4. These results are fixture-only, not live-provider evidence.
- Focused post-integration regressions passed, including 12 world-state tests plus deterministic activation and evidence-wire tests. The final review-fix suite passed 122/122 and covers every independently found issue described above, including atomic rollback and replay.
- `just codegen-check` identified earlier integrated test-inventory drift; `just codegen` refreshed it in `ac1af9fb`, and the final exact-head deterministic check passes.
- Exact desktop tests passed 890 with 11 skipped and zero failures; the Electron production build passed. Exact `030df02b` source launched with isolated user data, rendered onboarding, accepted **Skip setup**, rendered the main composer, and displayed the completed task with **Done**, **Work completed**, **1/1 checks passed**, grouped activity, and the verification response. This was not a signed/package artifact.
- Exact live task `39a1cc03-09ab-467c-af43-db2974feb0e8`, turn `595e9604-0558-4c86-b772-eb2a84e00208`, ran on kernel build digest `8a045eb4edb9996993586f398b7713dbbb41ef72`. Task and turn reached `COMPLETED`, task phase reached `COMPLETE`, file bytes were exactly `status=FIXED\n`, and `bun verify.ts` exited zero. Metrics recorded five steps, 25,584 input tokens, 16,000 cached input tokens, 375 output tokens, and zero computed cost. Plan `2df47d0b-6dde-4125-8a30-7f21c1d85b9d` passed, completion `completion:39a1cc03-09ab-467c-af43-db2974feb0e8` committed, and the evidence bundle was `scope: "turn"`, matched the turn, carried the dirty revision binding, and was `COMMITTED`.
- Immediate restart attempts failed closed until the previous writer lease expired. Recovery then acquired a new fenced lease, replayed six tasks, and read back the same terminal task, turn, evidence, dirty revision, and exact kernel digest.
- Evidence returned by the task surface is explicitly turn-scoped. Task completion is separately established by the committed completion record and verification plan; a completed turn bundle alone is not task-completion evidence.
- All three named research branch tips were verified as ancestors of the integration head.
- Competitive claims above were checked against current first-party sources as of the research cutoff.
- Comparative live cohorts, paid-provider receipts, signed/packaged macOS, UI-initiated provider execution, full AA campaign, current-head release, isolated broad execution, real Linux `bwrap` runtime evidence, governed computer use, desktop loading/error/approval/repair/interruption/recovery states, and complete accessibility evidence remain open. The report-only commit following `8a045eb4` is not a new exercised-code revision.

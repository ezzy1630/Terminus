# Roadmap

This document is Forge's implementation roadmap (SPEC §48), organized into milestones M0–M12. Each milestone has an objective, tasks, deliverables, and an exit gate. Work may continue experimentally past a milestone, but the next default layer does not depend on an unpassed gate.

## Delivery principles (SPEC §48.1)

- Build measurement and security boundaries before sophisticated cognition.
- Deliver vertical slices that can be exercised through the public API.
- Keep inherited OpenCode behavior available behind flags until replacement parity is proven.
- Remove ambient effect paths continuously; do not postpone them to a final security phase.
- Every milestone has an exit gate.
- Prefer one-way migrations and compatibility facades over broad rewrites.
- Every milestone produces runbooks, tests, and observability, not only code.

## Suggested workstreams (SPEC §48.2)

1. **Runtime and security** — Rust kernel, sandbox, process/jobs, policy, secrets, egress, patch engine.
2. **Control and context** — domain, storage, sessions/tasks, context compiler, providers, orchestration, verification.
3. **Product and ecosystem** — clients, OpenCode bridge, skills/MCP/plugins/adapters, configuration, docs.
4. **Evaluation and quality** — benchmark lab, fake provider, conformance, security tests, statistics, release quality.

Cross-cutting owners: protocol, security, upstream integration, developer experience.

## Milestones

### M0 — Governance, reproducibility, and baseline laboratory (SPEC §48.3)

**Objective:** Create the conditions to know whether the project is improving.

**Tasks:** Repository, ownership, root AGENTS.md, contribution guide, security policy, ADR process; pin OpenCode upstream; divergence-budget file; minimal shell-oriented control agent; generic eval task format and environment lock format; deterministic fake-provider support; runners for upstream OpenCode and minimal baseline; additional runners for Codex, Pi, Oh My Pi, etc.; end-state graders and hidden-test isolation; token/cost/latency recording; repeated-run variance; primary metrics and promotion rules; evaluation-results schema and Parquet export; dashboard/notebook; benchmark data-handling policy.

**Deliverables:** `evals/` task runner; baseline harness adapters; fake provider; first reproducibility report; ADR-0001 through ADR-0005; minimal reference mode.

**Exit gate:** The same pinned configuration can be rerun and produce complete comparable records. Graders detect intentionally broken patches. Cost and latency reconcile within documented tolerances. Baseline variance is understood sufficiently to size later experiments.

### M1 — Fork-assisted bootstrap and substrate gate (SPEC §48.4)

**Objective:** Reuse OpenCode without allowing it to define permanent boundaries.

**Tasks:** OpenCode compatibility/parity test suite; inventory all inherited effect paths; exact provider-request capture; Forge task contracts; context-manifest skeleton; artifact store facade; public Forge API facade and generated client skeleton; four substrate tests (exact context visibility, total effect interception feasibility, independent task/checkpoint ownership, provider-specific rendering injection); document which OpenCode packages require patching; upstream sync CI; isolate Bun-specific APIs; disable automatic plugin installation; explicit extension lockfiles; fork/overlay decision ADR.

**Deliverables:** `packages/open-code-bridge`; effect-bypass register; provider-request recorder; OpenCode parity suite; fork gate report.

**Exit gate:** Every critical invariant is either achievable through a stable seam or mapped to a narrowly owned fork patch. No critical behavior remains "assumed interceptable."

### M2 — Domain model, persistence, artifacts, and public lifecycle (SPEC §48.5)

**Objective:** Make sessions, tasks, turns, events, artifacts, and recovery durable before privileged execution moves.

**Tasks:** UUIDv7 IDs and URI types; SQLite migration framework and schema checksum; workspace/session/thread/task/turn/provider-attempt/event repositories; state-machine guards and property tests; semantic event envelope and event catalog generator; content-addressed artifact ingestion, metadata, streaming, and GC dry run; task contract versioning and scope ledger; task terminal states and completion record skeleton; SSE event stream with cursors and reconnect; idempotency-key storage; portable trace export; startup recovery report; database/artifact backup and restore test; public API resource snapshots and health endpoints; integrate inherited TUI through public facade.

**Exit gate:** A task can be created, streamed, interrupted, control-plane restarted, resumed, completed, and exported without a privileged kernel or real model.

### M3 — Kernel protocol and non-bypassable effect path (SPEC §48.6)

**Objective:** Establish the privileged Rust boundary and route all new effects through it.

**Tasks:** `forge.kernel.v1` Protobuf packages and Buf compatibility checks; authenticated gRPC over UDS; request context, idempotency, deadline, cancellation, typed error mapping; kernel instance identity and short-lived capability tokens; safe workspace/path types; artifact ingest service integration; structured `exec` without sandbox (temporary test backend); process-tree ownership, output streaming, timeout, cancellation; durable jobs and PTY streams; control-plane kernel client and fake kernel; route one inherited command path through kernel; route all Forge-owned commands through kernel; direct-effect architecture checks in TypeScript; process restart and job reconciliation; kernel protocol compatibility tests; load/backpressure tests.

**Exit gate:** No Forge-owned process or file mutation bypasses the kernel. Remaining inherited bypasses are known, contained, tested, and scheduled for removal.

### M4 — Sandbox, policy, secrets, network, and Git protection (SPEC §48.7)

**Objective:** Make the effect boundary enforce meaningful security.

**Tasks:** Common sandbox policy model and backend trait; Linux Bubblewrap backend with read-only root and writable worktree; re-protect `.git`, Forge state, secret paths, denied globs; user/PID/network namespaces, no-new-privileges, seccomp, cgroup controls; explicit degraded-mode detection; structured command normalization and shell AST parser; versioned command/effect policy engine; approval records bound to normalized action hashes; secret capability broker with short-lived child injection; output redaction and secret-use audit; proxy-only network namespace and destination allowlists; DNS rebinding/private-address protections; protected Git worktree/branch/commit operations; disable untrusted Git hooks and filters; macOS and Windows backend scaffolds with honest capability reporting; container backend for untrusted evals/extensions; run sandbox, secret, network, and process-tree adversarial suites; remove inherited direct effect paths or place inherited control plane in outer sandbox until removed.

**Exit gate:** The secure local profile passes the non-bypassability and adversarial security suite on supported Linux. Unsupported platforms fail closed or explicitly select a degraded profile.

### M5 — ACI v1 and transactional editing (SPEC §48.8)

**Objective:** Expose a small, reliable, token-efficient interface.

**Tasks:** Canonical tool/result schemas and generator; `read` with outline, ranges, symbols, hashes, elisions, artifacts; lexical `search` with rank/facets/continuation; Tree-sitter symbol/structural index; dependency/import/test graph; LSP enrichment and index freshness; `inspect` diagnostics, symbol, reference, diff, test-status; patch baseline and edit schemas; transaction overlay, path leases, journal, rollback, crash recovery; symbol/range/exact-text/unified-diff anchors; format and parser validation; multi-file operations and transient-invalid isolated mode; bounded `exec` result extraction and diagnostic parsers; `job` model-facing operations; `capability` search/activation skeleton; tool descriptions and golden examples; ACI conformance and model-selection tests; compare default tool palette against minimal shell and alternate palettes.

**Exit gate:** At fixed models and budgets, ACI v1 improves edit-application success or final task success on its target cohort without unacceptable cost/security regression. Patch recovery passes forced-crash tests.

### M6 — Context Compiler v1 and lossless continuity (SPEC §48.9)

**Objective:** Replace transcript accumulation with typed, inspectable, provider-rendered context.

**Tasks:** Context IR runtime schemas and persistence; world-state producer registry; integrate inherited OpenCode context sources and epochs through bridge; project instruction discovery and scope resolution; task-contract, scope, budget, diagnostics, jobs, tests, permissions fragments; retrieval query generation; integrate lexical/AST/LSP retrieval; deduplication and source-version validation; evidence-coverage matrix and gap expansion; scoring and budget allocator; recent complete-episode selection; structured checkpoint schema and generator; checkpoint validation against contract/requirements/failures; provenance DAG and source expansion; exact context manifest persisted before provider send; context explanation UI/CLI; counterfactual replay support; full-history vs. checkpoint/recent-window experiments; retrieval and position ablations.

**Exit gate:** Long-horizon target tasks achieve non-inferior or improved success with lower context/cost, and requirement-loss tests pass. Every provider request is explainable from a manifest.

### M7 — Provider renderers, caching, and model economics (SPEC §48.10)

**Objective:** Exploit provider features without corrupting the canonical architecture.

**Tasks:** Provider/model capability registry and snapshot persistence; OpenAI renderer with exact prefix/cache/continuation; Anthropic renderer with cache/system/tool semantics; Google renderer with implicit/explicit cache; local-model renderer and chat-template/tokenizer adapters; provider response projection and native metadata compatibility; observed token/cache/cost accounting; deterministic model routing profiles and fallback; per-role/request/task budgets; provider health, queues, rate limits, circuit breakers; output styles and structured worker outputs; external compression interface and shadow-mode harness; integrate The Token Company only behind experimental privacy gate; provider-specific cache and compaction experiments; model-specific edit-dialect experiments.

**Exit gate:** Provider renderers pass exactness and compatibility tests. Cache/cost improvements are observed on target workloads without quality or privacy regression.

### M8 — Verification engine and selective orchestration (SPEC §48.11)

**Objective:** Make completion environment-grounded and multi-agent execution economically selective.

**Tasks:** Verification-plan schema and DAG scheduler; standard predicate library; map task acceptance criteria to predicates; changed-code invalidation; completion record and report renderer; deterministic scheduler features and expected-value policy; read-only scouts; managed writing worktrees; delegation contract/result schemas; worker budget and cancellation; integration coordinator and conflict handling; reviewer triggers and detached review; finding lifecycle; loop detection and interventions; one-agent/scout/writer/reviewer ablations; tune thresholds by task cohort.

**Exit gate:** Verification prevents false completion in tests. Multi-agent mode improves the separable cohort and remains disabled or neutral on non-separable tasks.

### M9 — Skills, MCP, plugins, and external harness adapters (SPEC §48.12)

**Objective:** Open the ecosystem without dissolving the security boundary.

**Tasks:** Capability descriptor, registry, lockfile, activation lifecycle; Agent Skills discovery and permission-checked body loading; `forge.skill.yaml` validation and skill tests; isolated skill-script execution; MCP registration, descriptor hashing, admission; per-tool effect classification and policy; MCP process/HTTP isolation and output limits; descriptor-change reauthorization; third-party plugin process/WASI host; deterministic hook semantics and timeouts; explicit isolated extension installation with lifecycle scripts disabled; external adapter SDK and fixture agent; Codex, Pi, and one additional adapter; live capability probes and discrepancy reports; malicious plugin/MCP/adapter security suite; evaluate programmatic tool-composition mode.

**Exit gate:** Third-party code cannot acquire ambient effects. Descriptor changes are detected. External harness results are independently verified.

### M10 — Curated durable memory (SPEC §48.13)

**Objective:** Reduce repeated work across sessions without allowing stale beliefs to become authority.

**Tasks:** Memory candidate schema and extraction queue; secret/privacy filtering; consolidation lease and curator sandbox; contradiction, supersession, expiration; BM25 retrieval and scope filters; optional semantic retrieval behind flag; cheap revalidation hooks; memory explanation, disable, export, reset, quarantine; usage and harmful-use telemetry; procedure-to-skill promotion workflow; memory precision/harm experiments.

**Exit gate:** Memory produces positive held-out utility with a low harmful-retrieval rate and complete provenance. It remains disabled by default until this gate passes.

### M11 — Clients, remote execution, and collaboration (SPEC §48.14)

**Objective:** Turn the kernel into a usable product across terminal, IDE, CI, and remote environments.

**Tasks:** Harden TUI reconnection, approvals, context/evidence views, job controls; non-interactive CLI commands for CI and automation; complete ACP adapter and editor integration; optional web/desktop clients using generated API clients; remote kernel mTLS and identity; remote workspace/environment descriptors; container/micro-VM pool and image pinning; tenant quotas and isolation if multi-user mode is in scope; collaboration roles and session handoff; audit/export controls; remote failure/reconnect and upgrade tests.

**Exit gate:** Remote and local tasks share the same domain/evidence semantics. Isolation and identity tests pass. Clients recover from disconnect without corrupting task state.

### M12 — Hardening and stable release (SPEC §48.15)

**Objective:** Prove the product can be installed, upgraded, operated, secured, and maintained.

**Tasks:** Complete supported platform matrix; long-duration soak and resource-leak tests; full security assessment and fix/accept findings; migration, backup, restore, and rollback drills; upstream sync and divergence report; benchmark release comparison and publish methodology; freeze stable public/proto schema versions; complete user/admin/security/runbook documentation; sign binaries/images and publish SBOM/provenance; preview canary and collect operational metrics; resolve critical UX and approval-fatigue issues; establish incident, disclosure, and patch processes.

**Exit gate:** All release-gate requirements in SPEC §46.18 and the checklist in §50 pass.

## Current status (0.1.0 development)

- M0 tasks: scaffolded (eval lab functional, 158/175 tests passing).
- M1 tasks: scaffolded (bridge, bypass register, parity suite stubs).
- M2 tasks: scaffolded (Prisma schema, migrations, repositories).
- M3 tasks: scaffolded (kernel proto, mini-service, fake kernel).
- M4 tasks: scaffolded (sandbox backends, policy, secrets, egress).
- M5 tasks: scaffolded (ACI tools, patch engine, code-intel).
- M6 tasks: scaffolded (context IR, compiler, retrieval).
- M7 tasks: scaffolded (provider renderers, router).
- M8 tasks: scaffolded (verification, orchestration).
- M9 tasks: scaffolded (skills, MCP, plugins, adapters).
- M10 tasks: scaffolded (memory, disabled by default).
- M11 tasks: not started.
- M12 tasks: not started.

See `docs/plans/pr-sequence.md` for the first 40 PRs.

## Related

- `docs/plans/pr-sequence.md` — first 40 PRs.
- `docs/quality/release-gates.md` — release gate criteria.
- `docs/decisions/` — ADRs govern cross-milestone decisions.
- SPEC §21 (stage summary), §22 (initial PR sketch), §48 (detailed roadmap).

# Terminus

> A provider-neutral coding-agent operating system designed around a Rust effect kernel, an inspectable Context Compiler, evidence-based completion, and an eval gate for complexity.

Terminus is built from the [complete product, architecture, security, and implementation specification](SPEC.md). It is a standalone runtime: Terminus owns ARP, its public API and client, provider-neutral contracts, evidence, context manifests, and the Rust effect boundary.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ CLIENTS                                                          │
│ TUI · CLI · Desktop (Electron) · IDE/ACP · SDK · CI             │
└──────────────────────────────┬───────────────────────────────────┘
                               │ Public API / SSE (SPEC §30, §32)
┌──────────────────────────────▼───────────────────────────────────┐
│ CONTROL AND COGNITION PLANE — TypeScript                        │
│                                                                  │
│ Session/task engine     Context Compiler       Provider renderers│
│ Model broker            Scope/policy coordinator Agent scheduler │
│ Verification planner    Capability registry   External adapters │
└───────────────┬───────────────────────────┬──────────────────────┘
                │ privileged effects RPC    │ unprivileged capability RPC
┌───────────────▼────────────────────┐  ┌───▼──────────────────────┐
│ EXECUTION/SECURITY MICROKERNEL     │  │ CAPABILITY PLANE         │
│ Rust effect boundary               │  │                          │
│                                    │  │ Built-in tools · Skills  │
│ Sandbox broker (Bubblewrap/Seatbelt)│  │ MCP servers · Plugins   │
│ Process supervisor / jobs          │  │ External harness adapters│
│ FS snapshot/edit transactions      │  │                          │
│ Network egress proxy               │  │ Runs out of process      │
│ Secret broker                      │  │                          │
│ Resource/cgroup limits             │  │                          │
│ LSP/DAP/Tree-sitter services       │  │                          │
│ Artifact store (CAS + SQLite)      │  │                          │
└───────────────┬────────────────────┘  └──────────────────────────┘
                │
┌───────────────▼──────────────────────────────────────────────────┐
│ WORKSPACES                                                       │
│ Local worktrees · containers · gVisor · micro-VMs · remote      │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│ EVIDENCE, EVALUATION, AND EVOLUTION PLANE (Python)              │
│ Exact manifests · artifacts · traces · replay · ablations       │
│ Security conformance · A/B tests · cost/cache analytics         │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│ DATA PLANE                                                       │
│ SQLite/WAL · semantic event log · content-addressed blobs       │
│ Git/worktrees · FTS5/BM25 · OpenTelemetry · Parquet analytics   │
└──────────────────────────────────────────────────────────────────┘
```

### Non-bypassability invariant (SPEC §5.2)

> No model-facing process, TypeScript module, plugin, skill script, MCP server, or external agent can directly spawn a host process, mutate a file, access a secret, or open a network connection outside the Rust broker.

All effects cross the Rust kernel boundary. The control plane has no ambient authority. Plugins run in separate processes with capabilities. Secrets are short-lived process capabilities, never environment-wide values.

### Component maturity and evidence

Every component is classified `fixture | stub | experimental | preview | production` in the machine-readable [`maturity.yaml`](maturity.yaml) registry (generated view: [docs/generated/component-maturity.md](docs/generated/component-maturity.md)). No component is `production` yet: production requires conformance-tested signed evidence at HEAD. Static repository facts live in the generated [static inventory](docs/generated/inventory.md); executed-test evidence lives only in CI artifacts on an exact commit and under `artifacts/release-gate/`.

---

## Repository structure

```
terminus/
├── apps/
│   ├── desktop/              # Electron + React + TypeScript macOS app
│   ├── tui/                  # Terminal client (primary per SPEC §43.4)
│   ├── cli/                  # Non-interactive CLI for CI/automation
│   └── ide-acp/             # ACP adapter for editor integration
├── packages/                 # TypeScript packages (domain, context, providers, ...)
├── crates/                   # Rust crates (kernel, sandbox, process, patch, ...)
├── mini-services/
│   ├── terminus-kernel/         # Rust kernel HTTP service (port 3040)
│   └── terminus-control/        # TS control plane HTTP service (port 3050)
├── python/forge_evals/       # Python evaluation laboratory
├── adapters/                 # External harness adapters (codex, claude-code, pi, ...)
├── skills/                   # Agent Skills (builtin + fixtures)
├── capability-packs/         # Tool packs (web, github, database, debugger, ...)
├── policies/                 # Sandbox, command, network, secrets, organizations
├── prompts/                  # Authority, provider-renderer, checkpoint, delegation, review, memory
├── schemas/                  # Domain JSON Schemas, event catalog, tool definitions
├── evals/                    # Benchmark suites, task packages, graders, security tests
├── proto/                    # Protobuf kernel protocol (Appendix D)
├── migrations/sqlite/        # SQL migrations (Appendix C)
├── prisma/                   # Prisma schema (TypeScript-facing)
├── docs/                     # Architecture, ADRs, runbooks, security, plans
├── scripts/                  # Start services, migrations, codegen
├── tools/                    # Codegen, boundary checks, scaffolding
├── AGENTS.md                 # Root repository instructions (Appendix G)
├── SECURITY.md               # Trust zones, threat model, non-bypassability
├── CONTRIBUTING.md           # Contribution guide + PR template
├── SPEC.md                   # The normative specification
└── justfile                  # Root task runner (SPEC §43.7)
```

---

## Quickstart

### Prerequisites

- **Rust** 1.97+ (`rustup`)
- **Bun** 1.3+ (TypeScript runtime + package manager)
- **Python** 3.12+ with **uv**
- **just** (task runner)
- **macOS** for desktop app packaging (Linux for development)

### Start the services

```bash
# Start the Rust kernel (port 3040) + TS control plane (port 3050)
bash scripts/start-mini-services.sh

# Start the Next.js API surface page (port 3000, via Caddy gateway on :81)
bash scripts/start-next.sh

# Start the desktop app (on macOS)
cd apps/desktop && bun install && bun run dev:electron
```

### Verify

```bash
# Kernel health
curl -sS http://127.0.0.1:3040/v1/health \
  -X POST -H "Authorization: Bearer terminus-kernel-dev-token" -d '{}'

# Control plane health
curl -sS http://127.0.0.1:3050/v1/system/health \
  -H "Authorization: Bearer terminus-control-dev-token"

# Local control-path smoke: create workspace → session → task → turn
W=$(curl -sS -X POST http://127.0.0.1:3050/v1/workspaces/open \
  -d '{"root_uri":"/tmp/terminus-demo"}' \
  -H "Authorization: Bearer terminus-control-dev-token" | jq -r .id)

S=$(curl -sS -X POST http://127.0.0.1:3050/v1/sessions \
  -d "{\"workspace_id\":\"$W\",\"title\":\"demo\"}" \
  -H "Authorization: Bearer terminus-control-dev-token" \
  | jq -r '.id,.active_thread_id')
SID=$(echo "$S" | head -1); TID=$(echo "$S" | tail -1)

T=$(curl -sS -X POST http://127.0.0.1:3050/v1/tasks \
  -d "{\"session_id\":\"$SID\",\"thread_id\":\"$TID\",\"objective\":\"demo\"}" \
  -H "Authorization: Bearer terminus-control-dev-token" | jq -r .id)

curl -sS -X POST "http://127.0.0.1:3050/v1/tasks/$T/start" \
  -H "Authorization: Bearer terminus-control-dev-token" > /dev/null

curl -sS -X POST http://127.0.0.1:3050/v1/turns \
  -d "{\"thread_id\":\"$TID\",\"task_id\":\"$T\",\"user_input\":\"hello terminus\"}" \
  -H "Authorization: Bearer terminus-control-dev-token" > /dev/null

sleep 5

# Without a kernel-brokered provider transport, the task must fail closed as
# BLOCKED with provider_transport_unavailable. A synthetic model response is
# never substituted.
curl -sS "http://127.0.0.1:3050/v1/tasks/$T" \
  -H "Authorization: Bearer terminus-control-dev-token" \
  | jq '{status,phase,terminal_reason}'
```

### Use the clients

```bash
# TUI (primary client)
bun apps/tui/src/index.ts health
bun apps/tui/src/index.ts sessions
bun apps/tui/src/index.ts events <task-id>

# CLI (CI/automation)
bun apps/cli/src/index.ts health
bun apps/cli/src/index.ts new-task --session <id> --thread <id> --objective "fix the bug"
bun apps/cli/src/index.ts wait <task-id> --timeout 300

# Desktop app (macOS)
cd apps/desktop && bun run dev:electron
```

---

## Implementation stack

### Rust — trusted and performance-sensitive (SPEC §43.1)

The intended trusted effect boundary. Terminus-owned execution paths route process, filesystem, network, secret, and patch operations through it. Whole-system non-bypassability remains a release claim gated by the supported-platform adversarial suite and signed evidence described in the research ledger.

> Test counts and per-crate inventory are generated from the source tree — see the [static inventory](docs/generated/inventory.md). Maturity per crate: [component maturity registry](docs/generated/component-maturity.md).

| Crate | Responsibility |
|---|---|
| `terminus-kernel` | Service assembly (13 service groups) |
| `terminus-kernel-protocol` | Request/response types, error codes |
| `terminus-authz` | Capability tokens (HMAC, audience, nonce, revocation) |
| `terminus-policy` | Command policy engine (strictest-wins rule evaluation) |
| `terminus-sandbox` | Sandbox backend trait + `LocalRestrictive` |
| `terminus-sandbox-linux` | Bubblewrap backend (real bwrap argv construction) |
| `terminus-sandbox-macos` | Seatbelt backend (deny-default profile generation, ADR-0035 §4) |
| `terminus-sandbox-windows` | AppContainer detection + honest reporting |
| `terminus-sandbox-container` | Container/micro-VM backend stub |
| `terminus-process` | Process manager (env_clear, process groups, timeout, bounded stdio capture) |
| `terminus-jobs` | Job state machine (process-local child supervision with durable JSON state and restart reconciliation) |
| `terminus-fs` | Safe path resolution (traversal/symlink rejection) |
| `terminus-patch` | Transactional edit engine (journal, snapshots, rollback) |
| `terminus-artifacts` | CAS (sha256 layout, atomic rename, SQLite metadata) |
| `terminus-secrets` | Secret broker (handles, redaction; raw-value API slated for replacement in Phase 4) |
| `terminus-egress` | Network egress proxy (allowlist, DNS, private-address denial) |
| `terminus-code-intel` | Tree-sitter symbol index |
| `terminus-extension-runtime` | WASI extension host stub |
| `terminus-git` | Protected worktree/commit/merge operations |
| `terminus-kernel-testkit` | Fakes, builders, in-memory stores |

### TypeScript — rapidly changing product/cognition (SPEC §43.2)

The control plane. Owns sessions, tasks, context compiler, providers, orchestration, verification, memory, and the public API. No ambient effect authority.

| Package | Responsibility |
|---|---|
| `@terminus/domain` | Canonical types, state machines, typed errors |
| `@terminus/runtime-protocol` | 40+ semantic event types, SSE encoder/decoder |
| `@terminus/context-ir` | Context fragments, source descriptors, exactness classes |
| `@terminus/context-compiler` | 16-step assembly algorithm, retrieval pipeline, budget allocator |
| `@terminus/provider-core` | Provider-neutral broker, capability snapshots, cost accounting |
| `@terminus/provider-{openai,anthropic,google,local}` | Provider-specific renderers |
| `@terminus/model-router` | Deterministic routing, rate limiting, circuit breaker |
| `@terminus/task-runtime` | Task lifecycle, contract versioning, scope ledger |
| `@terminus/session-runtime` | Session/thread/turn services, context epoch lifecycle |
| `@terminus/orchestration` | Scheduler, delegation, worktree ownership, loop detection (10 signals), budget control, cancellation |
| `@terminus/verification` | DAG engine (parallel execution), 17 predicate types, changed-code invalidation, flaky-test policy |
| `@terminus/memory` | Candidate extraction, consolidation, retrieval, working memory |
| `@terminus/capability-registry` | Skills, MCP, plugins, activation lifecycle |
| `@terminus/extension-host` | WASI/Process hosts, hook semantics |
| `@terminus/adapter-sdk` | External harness adapter SDK |
| `@terminus/policy-coordinator` | Bridges task contracts and kernel capability requests |
| `@terminus/artifact-client` | Artifact ingest/get/link/gc |
| `@terminus/observability` | OTel spans, structured logging, metrics |
| `@terminus/config` | Layered typed configuration (defaults < org < user < workspace < task) |
| `@terminus/testkit` | Fake provider, fake kernel, builders |
| `@terminus/public-api` | HTTP API definitions, error envelope, SSE, 18 resource groups |
| `@terminus/public-client` | Generated-style TypeScript client with SSE subscription |
| `@terminus/aci` | Agent-Computer Interface (ToolRegistry, ProgressiveDisclosure) |

Package inventory and declared-test counts are generated — see the [static inventory](docs/generated/inventory.md).

### Python — offline/non-privileged research (SPEC §43.3)

The evaluation laboratory. Never on the production enforcement path.

| Module | Responsibility |
|---|---|
| `runners/` | Harness runner, cross-harness comparison, fake provider, mini-SWE adapter, trajectory recorder |
| `graders/` | End-state, acceptance, security (11 graders), conformance |
| `analysis/` | Load runs, aggregate, cost analysis, cache analysis, regression detector |
| `statistics/` | Paired t-test, bootstrap CI, multiple comparisons, effect size, non-inferiority |
| `dashboards/` | Cohort, feature contribution, security report |
| `research/` | Context ablations, ACI ablations, orchestration ablations, routing research |
> Module and test counts are generated — see the [static inventory](docs/generated/inventory.md).

### Data (SPEC §7.3, §29)

- **SQLite/WAL** — operational state, indexes, leases, task ledgers
- **Semantic event log** — append-only audit events (task/tool/effect/verification transitions)
- **Content-addressed artifact store** — CAS with sha256 layout + SQLite metadata bridge
- **Git/worktrees** — repository state and isolated changes
- **FTS5/BM25** — lexical retrieval for source files and memory claims
- **OpenTelemetry** — traces, metrics, structured logs
- **Parquet/DuckDB** — analytical exports for eval analysis

---

## Clients

### Desktop application (SPEC §43.4, desktop UI spec)

An experimental Electron + Vite + React + TypeScript desktop application at
`apps/desktop/`. It uses macOS window integration, but it is not a native
AppKit/SwiftUI client and has no production maturity claim.

- **Mission board and operator cockpit** — task-centered board, attention center modal, real-time SSE stream integration, and fleet budget views
- **Full virtualization** — `@tanstack/react-virtual` for conversations (thousands of messages), sidebar lists (thousands of tasks), and diff viewers (10k+ lines)
- **Command palette** (⌘K) — fuzzy search, grouped results, and keyboard navigation
- **Diff viewer** — unified + side-by-side, hunk review, inline feedback, and patch approval workflow
- **Dynamic inspector** — sections appear only when relevant (Environment, Activity, Approvals, Subagents, Changes, Verification)
- **Onboarding** — 4-step flow (Welcome → Project → Tools → First task)
- **Settings** — categories with search, per-setting reset, immediate appearance preview

```bash
cd apps/desktop
bun install
bun run dev:electron    # Vite + Electron concurrently
bun run package         # Produces release/Terminus-0.1.0-arm64.dmg
```

### TUI (SPEC §43.4 primary client)

```bash
bun apps/tui/src/index.ts health       # System + kernel health
bun apps/tui/src/index.ts sessions     # List sessions
bun apps/tui/src/index.ts tasks <sid>  # List tasks in a session
bun apps/tui/src/index.ts events [tid] # Subscribe to SSE event stream
bun apps/tui/src/index.ts new          # Create workspace+session+task+turn
```

### CLI (SPEC §42.1 non-interactive)

```bash
bun apps/cli/src/index.ts health
bun apps/cli/src/index.ts new-task --session <id> --thread <id> --objective "fix bug"
bun apps/cli/src/index.ts start-turn --thread <id> --task <id> --input "fix it"
bun apps/cli/src/index.ts wait <task-id> --timeout 300
bun apps/cli/src/index.ts events --task <id>    # SSE as JSONL
```

### IDE/ACP (SPEC §32.6)

ACP-over-stdio JSON-RPC adapter for editor integration. Not privileged — calls the public API only.

---

## Security (SPEC §13, §27, §36)

### Trust zones (SPEC §27.2)

| Zone | Examples | Trust | Ambient authority |
|---|---|---|---|
| Z0 | kernel policy engine, secret broker | highest | narrowly defined host capabilities |
| Z1 | control plane, signed first-party clients | trusted, non-privileged | no raw process/fs/network authority |
| Z2 | built-in tools, code-intelligence workers | constrained | explicit kernel grants |
| Z3 | first-party plugins, adapters | partially trusted | declared capabilities only |
| Z4 | third-party plugins, MCP servers, external harnesses | untrusted | isolated capability grants only |
| Z5 | model output, repository text, web content, issues, logs | untrusted data | none |

### Enforcement (SPEC §31.3)

Every kernel effect request follows the 14-step validation order:
1. authenticate connection → 2. validate schema → 3. validate capability token → 4. resolve workspace/sandbox → 5. canonicalize paths (reject traversal/symlink escape) → 6. classify effect + taint → 7. evaluate command/resource policy → 8. resolve approval → 9. reserve budgets → 10. persist AUTHORIZED state → 11. execute → 12. stream bounded observations → 13. settle + persist evidence → 14. release leases

### Capability tokens (SPEC §31.6)

Short-lived, audience-restricted, nonce-protected, revocable tokens bound to:
- principal, session, task, workspace
- operation classes (Read, Patch, Exec, Job, Sandbox, Policy, Secret, Network, CodeIntel, Extension, Git, ArtifactIngest, Admin)
- max scope (workspace_paths, network_destinations, secret_capabilities)

End-to-end tests verify: operation-class enforcement, path-scope enforcement, network-destination enforcement, secret-capability enforcement, expiry, revocation, audience mismatch, signature tampering.

### Sandbox backends (SPEC §13.4, §36.5-§36.8)

- **Linux**: Bubblewrap detection + real `bwrap` argv construction (`--unshare-all`, `--ro-bind`, `--proc`, `--dev`, `--die-with-parent`, `--new-session`, `--cap-drop ALL`). Reports `Enforced` when bwrap is available; reports `Degraded` when it is unavailable, while profiles that require namespace isolation are refused as `Unsupported`.
- **macOS**: Seatbelt (`sandbox-exec`) backend translating `SandboxProfile` into deny-by-default Scheme syntax with per-subpath allowances (ADR-0035 §4); reports `Enforced` when functional execution succeeds or `Degraded` when disabled/unsupported, while profiles that require unavailable controls are refused.
- **Windows**: AppContainer/Job Object detection. Reports `Degraded` with "CreateProcess+Job Object wiring not implemented" note.
- **Container/micro-VM**: Stub for gVisor/Firecracker backends.

**Never silently downgrade** (SPEC §13.4): the UI displays effective enforcement at all times.

---

## Persistence (SPEC §29)

### SQLite requirements (SPEC §29.2)

- WAL journal mode, foreign keys ON, busy timeout 5s, synchronous NORMAL
- Monotonic checksum-verified migrations (`migrations/sqlite/0001_initial.sql`)
- Single writer queue per database file
- Startup integrity check (`PRAGMA quick_check`)
- JSON columns schema-versioned and validated before insertion

### Artifact store (SPEC §29.3)

Content-addressed storage with:
- SHA-256 layout: `sha256/ab/cd/<hash>`
- Streaming hash + atomic rename + `fsync` + parent dir `fsync`
- **SQLite metadata bridge**: metadata upserted into `artifacts` table after CAS rename; `artifact_links` table tracks ownership
- JSON sidecar fallback for backwards compatibility
- Reference-aware GC with `legal_hold` protection
- Retention classes: `ephemeral`, `session`, `audit`, `evidence`, `memory_source`, `legal_hold`

### Checkpoint and recovery (SPEC §29.5)

- Durable checkpoints with: schema version, session/thread/task IDs, last committed sequences, active context epoch, unsettled tool calls, active jobs, workspace revision, dirty-state digest, unsettled external effects, artifact references, continuation state
- 10-step startup recovery: acquire lease → verify integrity → load non-terminal tasks/turns → reconcile jobs → reconcile patch transactions → reconcile external effects → mark interrupted attempts → restore context epochs → expose resumable/blocked/manual-review → emit recovery report
- `POST /v1/system/recover` endpoint runs the full recovery procedure

### Portable export (SPEC §29.6)

- `POST /v1/system/export` produces a self-describing, versioned, checksum-listed export with sessions, tasks, events, context manifests, and verification plans

---

## Context Compiler (SPEC §8, §33)

The Context Compiler — not the transcript — is the model's input authority. Before every provider attempt:

1. **Collect required fragments** — authority (policy), task contract, project rules, unresolved acceptance criteria (hard-included)
2. **Derive retrieval queries** — from objective, changed files, diagnostics, symbols, tests, unknowns
3. **Retrieve** — exact paths → lexical BM25 → tree-sitter symbols → LSP references → dependency graph → fault localization → optional semantic
4. **Deduplicate and validate freshness** — reject stale versions
5. **Build evidence-coverage matrix** — expand for gaps
6. **Score candidates** — `utility = relevance × authority × freshness × novelty × coverage × uncertainty_reduction × risk_reduction × model_compatibility / token_cost`
7. **Allocate budget** — reserve output/reasoning/tool-results/recovery; greedy selection preserving dependency closure and complete-episode integrity
8. **Plan cache epoch** — stable prefix, volatile suffix
9. **Render provider-specific request** — via provider renderer
10. **Persist manifest** — durable before send

Every request records: exact fragment IDs, source hashes, order, role mapping, rendered text hash, omitted candidates + reasons, token estimates vs actual usage, cache reads/writes, tool-schema versions, trust/confidentiality decisions, compression transforms, policy/scope state.

### Context epochs (SPEC §8.7, §33.15)

`ContextEpochService` manages the immutable cacheable baseline lifecycle:
- Start new epoch on: first request, compaction completed, workspace/trust boundary changed, authority changed incompatibly, tool semantics changed, continuation incompatible, session fork, user requests clean context
- Seal epoch when replaced
- Ordinary world-state changes become deltas at safe provider-turn boundaries

---

## Verification (SPEC §17, §40)

Completion is evidence-based, not assertion-based. The model cannot produce `COMPLETED` without the harness accepting the evidence ledger.

- **DAG engine** with parallel execution (up to 4 nodes concurrently, dependency-respecting)
- **17 predicate types**: file_parses, formatter_check, static_diagnostics, unit_test, integration_test, e2e_test, property_test, fuzz_test, security_scanner, performance_threshold, schema_compatibility, migration_dry_run, diff_policy, acceptance_query, detached_review, human_approval, external_reconciliation
- **Changed-code invalidation** — path/symbol/test-ownership/build-graph aware
- **Flaky-test policy** — known-flake identity, historical rate, independent rerun limit, final confidence
- **Completion record** — final revision, criteria status, unresolved risks, accepted risks, cost, duration, final checkpoint

---

## Evaluation laboratory (SPEC §18, §41)

### Baselines (SPEC §18.2)

`terminus-minimal` (Bash-only permanent baseline), `terminus-full`, and external comparisons such as OpenCode, Codex, Claude Code, Pi, Oh My Pi, and mini-SWE-agent where automation is permitted. External comparisons are eval inputs, not runtime dependencies.

### Cohorts (SPEC §18.2, §41.3)

19 cohorts: tiny-bugfix, cross-file-feature, refactor, test-generation, unfamiliar-repository, build-failure, dependency-upgrade, migration, security-sensitive, large-context-migration, web-document-research, interruption/resume, compaction-mid-implementation, stale-snapshot-conflict, malicious-repository-instructions, poisoned-MCP-metadata, distributed-multi-tool-poisoning, parallelizable-task, task-where-multi-agent-should-lose.

### Statistical practice (SPEC §41.6)

Paired comparisons, bootstrap confidence intervals, multiple-comparison corrections (Bonferroni, Benjamini-Hochberg), effect sizes (Cohen's d, Hedges' g, Cliff's delta), non-inferiority tests for promotion gates.

### Feature promotion gate (SPEC §18.7, §41.12)

A feature becomes default only when it:
- Improves the intended cohort's Pareto frontier or satisfies a hard security/reliability need
- Has confidence bounds consistent with the claimed improvement
- Does not create unacceptable regressions in other critical cohorts
- Has operational observability and rollback
- Has documentation and migration behavior
- Remains within maintainability budgets

Security guardrail failure blocks promotion regardless of average task success.

---

## Development

### Commands (SPEC §43.7)

```bash
just bootstrap      # Install pinned tools/dependencies
just build          # Build Rust, TypeScript, and generated contracts
just check          # Fast lint/type/unit checks
just check-all      # Full local validation
just codegen        # Regenerate all derived contracts
just codegen-check  # Verify no generated drift
just unit           # All unit tests
just integration    # Integration tests
just security       # Local-capable security suite
just e2e            # End-to-end task tests
just eval-smoke     # Small deterministic eval suite
just standalone-check # Standalone runtime and direct ARP/client ownership
just release-check  # Release gate
just run            # Run control plane and kernel locally
```

### Testing

Declared test blocks are counted statically in the [static inventory](docs/generated/inventory.md); passing-run evidence is only meaningful per exact commit from CI artifacts. Run suites locally with:

```bash
just unit          # Rust + TS + Python unit tests
just integration   # integration suites
just e2e           # end-to-end task tests
just eval-smoke    # deterministic eval suite
```

### Architecture boundary checks (SPEC §42.5)

```bash
just boundary-check
# Checks: no packages/* imports child_process/fs/net/crypto (except allow-listed)
#         no packages/* imports from mini-services/ or apps/
#         no crates/terminus-kernel imports UI or provider code
#         no packages/domain imports provider SDKs
#         no raw SQL outside prisma/ and migrations/
```

### CI/CD (SPEC §46)

- **4-platform matrix**: Ubuntu x86_64, Ubuntu arm64, macOS arm64, Windows x86_64
- **Supply-chain gate**: `cargo deny`, `bun audit`, `pip-audit`, boundary-check, codegen-check
- **SBOM**: CycloneDX via `syft`, vulnerability scan via `grype`
- **Provenance**: `actions/attest-build-provenance`
- **Release channels**: nightly, preview, stable, lts

### Dev Container (SPEC §43.6)

`.devcontainer/` with TypeScript+Node base, Rust via rustup, mise-managed Bun/uv/just/buf/Python.

---

## Governance

### ADRs (Appendix H)

Architecture Decision Records at `docs/decisions/`, each with Context, Decision, Status, Alternatives, Consequences, Security Impact, Evaluation Plan, Migration, Rollback. The authoritative count lives in the [static inventory](docs/generated/inventory.md).

Statuses are recorded per ADR; consult each file's header for its current status.

### Runbooks (SPEC §47.9)

Runbooks at `docs/runbooks/`: database corruption, artifact store inconsistency, kernel/control version mismatch, sandbox unavailable, orphaned jobs, stuck external effect, leaked credential, compromised extension, provider outage, eval regression, security incident.

### Risk register (SPEC §49.4)

12 risks (R1-R12) with likelihood, impact, controls, triggers, and responses.

---

## License

Apache-2.0. See [LICENSE](LICENSE).

---

## Reference

- [SPEC.md](SPEC.md) — The complete normative specification
- [AGENTS.md](AGENTS.md) — Root repository instructions (Appendix G)
- [SECURITY.md](SECURITY.md) — Trust zones, threat model, non-bypassability
- [CONTRIBUTING.md](CONTRIBUTING.md) — Contribution guide + PR template
- [docs/](docs/) — Architecture, ADRs, runbooks, security, plans
- [worklog.md](worklog.md) — Complete build log (all tasks, agents, decisions)

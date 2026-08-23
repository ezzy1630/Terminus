# Component maturity registry

> Auto-generated from `maturity.yaml` by `tools/codegen/maturity.ts`.
> Do not edit by hand — run `just codegen`. Source of truth: `maturity.yaml`.

Tiers: `fixture` → `stub` → `experimental` → `preview` → `production`. `production` requires signed conformance evidence at HEAD; no component holds it today.

| Tier | Components |
|---|---:|
| `production` | 0 |
| `preview` | 11 |
| `experimental` | 46 |
| `stub` | 9 |
| `fixture` | 5 |

| Component | Kind | Path | Tier | Basis |
|---|---|---|---|---|
| `adapter-fixture-agent` | adapter | `adapters/fixture-agent` | `fixture` | Deterministic no-model test double; replays recorded trajectories |
| `eval-corpus` | eval-corpus | `evals` | `fixture` | Benchmark suites/tasks/graders/security fixtures — data, not production code |
| `terminus-kernel-testkit` | rust-crate | `crates/terminus-kernel-testkit` | `fixture` | Fakes/builders/in-memory stores for tests only |
| `provider-conformance` | ts-package | `packages/provider-conformance` | `fixture` | Conformance kit used to test provider renderers |
| `testkit` | ts-package | `packages/testkit` | `fixture` | Fake provider/fake kernel/builders for tests only |
| `adapter-claude-code` | adapter | `adapters/claude-code` | `stub` | Contract-stub runner (protocol only, no inner harness launch, lastVerified null) |
| `adapter-codex` | adapter | `adapters/codex` | `stub` | Contract-stub runner returns completed without invoking Codex (audit 4.9) |
| `adapter-oh-my-pi` | adapter | `adapters/oh-my-pi` | `stub` | adapter.yaml declaration only; runner not implemented |
| `adapter-omnigent` | adapter | `adapters/omnigent` | `stub` | adapter.yaml declaration only; runner not implemented |
| `adapter-openhands` | adapter | `adapters/openhands` | `stub` | adapter.yaml declaration only; runner not implemented |
| `adapter-pi` | adapter | `adapters/pi` | `stub` | Contract-stub runner (protocol only, no inner harness launch, lastVerified null) |
| `terminus-extension-runtime` | rust-crate | `crates/terminus-extension-runtime` | `stub` | WASI extension host stub |
| `terminus-sandbox-microvm` | rust-crate | `crates/terminus-sandbox-microvm` | `stub` | Tier-3 backend selection skeleton: hypervisor detection + pinned rootfs + machine-config generation; fail-closed, EXPERIMENTAL per ADR-0027 |
| `terminus-sandbox-windows` | rust-crate | `crates/terminus-sandbox-windows` | `stub` | Native AppContainer intentionally absent (unsafe FFI needs dedicated ADR); fail-closed WSL2/container fallback only (ADR-0035 §5) |
| `app-cli` | app | `apps/cli` | `experimental` | Non-interactive CLI for CI/automation |
| `app-desktop` | app | `apps/desktop` | `experimental` | Electron desktop app; README test-count claims replaced by inventory (Phase 0) |
| `app-ide-acp` | app | `apps/ide-acp` | `experimental` | ACP-over-stdio adapter for editors |
| `app-tui` | app | `apps/tui` | `experimental` | Terminal client (primary per SPEC §43.4) |
| `mini-service-control` | mini-service | `mini-services/terminus-control` | `experimental` | TS control plane HTTP service; authoritative stores remain process-local until Phase 2 |
| `mini-service-kernel` | mini-service | `mini-services/terminus-kernel` | `experimental` | Rust kernel HTTP mini-service outside root workspace (SPEC §42.5); checked via just kernel-mini-check |
| `forge-evals` | python-package | `python/forge_evals` | `experimental` | Runners/graders/statistics/dashboards substantial; release-tier evals are fixture-mode until model-backed runs are wired (scripts/run-release-evals.sh) |
| `terminus-authz` | rust-crate | `crates/terminus-authz` | `experimental` | Signed/scoped capability tokens real; revocation + nonce state in-memory (audit 4.4) |
| `terminus-code-intel` | rust-crate | `crates/terminus-code-intel` | `experimental` | Tree-sitter symbol index with basic tests |
| `terminus-connector` | rust-crate | `crates/terminus-connector` | `experimental` | L7 connector broker: grant-bound credential injection, exact-operation binding, response scrubbing; https fails closed pending TLS transport |
| `terminus-egress` | rust-crate | `crates/terminus-egress` | `experimental` | L4 broker real (DNS/IP/port/scheme/bytes); no L7 intent semantics yet (audit 4.7) |
| `terminus-git` | rust-crate | `crates/terminus-git` | `experimental` | Protected worktree/commit/merge operations, small test set |
| `terminus-jobs` | rust-crate | `crates/terminus-jobs` | `experimental` | Useful supervision but job state is process-local; durability claims prohibited until Phase 2 substrate exists (audit 4.5) |
| `terminus-kernel` | rust-crate | `crates/terminus-kernel` | `experimental` | Service assembly substantive (13 service groups); full non-bypassability not proven at HEAD (no CI run) |
| `terminus-remote` | rust-crate | `crates/terminus-remote` | `experimental` | Execution pool + digest-pinned image primitives |
| `terminus-sandbox-container` | rust-crate | `crates/terminus-sandbox-container` | `experimental` | Hardened OCI profiles with argv-proven enforcement report; permissive mode stays Degraded (ADR-0035 §3) |
| `terminus-sandbox-linux` | rust-crate | `crates/terminus-sandbox-linux` | `experimental` | Strongest platform path (real bwrap argv); needs current signed conformance evidence at HEAD |
| `terminus-sandbox-macos` | rust-crate | `crates/terminus-sandbox-macos` | `experimental` | Real Seatbelt profile generation + env -i payload allowlist; live effective-control probes Enforced on dev hosts (ADR-0035 §4) |
| `terminus-secrets` | rust-crate | `crates/terminus-secrets` | `experimental` | Opaque ConnectorGrants (workload identity + exact-operation binding) + residue scanner; raw-value API crate-private, InMemoryProvider fixture-only (ADR-0035 §1) |
| `aci` | ts-package | `packages/aci` | `experimental` | Agent-Computer Interface tools; unproven at HEAD |
| `adapter-sdk` | ts-package | `packages/adapter-sdk` | `experimental` | Stdio JSON-RPC adapter SDK; maturity gate added in Phase 0; live probes never run |
| `artifact-client` | ts-package | `packages/artifact-client` | `experimental` | Artifact ingest/get/link/gc client |
| `capability-registry` | ts-package | `packages/capability-registry` | `experimental` | Skills/MCP/plugins activation lifecycle |
| `context-compiler` | ts-package | `packages/context-compiler` | `experimental` | 16-step assembly algorithm; manifest reproduction not proven end-to-end at HEAD |
| `context-ir` | ts-package | `packages/context-ir` | `experimental` | Fragment/source-descriptor types |
| `extension-host` | ts-package | `packages/extension-host` | `experimental` | WASI/process hosts, hook semantics |
| `memory` | ts-package | `packages/memory` | `experimental` | Extraction/consolidation/retrieval with unit tests; promotion gates unproven on cohorts |
| `model-router` | ts-package | `packages/model-router` | `experimental` | Deep model profiles (Anthropic, OpenAI, Google, Local), empirical Bayesian posteriors, stage-aware deterministic router, rate limiting, circuit breaker, resumable continuation |
| `observability` | ts-package | `packages/observability` | `experimental` | OTel spans/logging/metrics wrappers |
| `open-code-bridge` | ts-package | `packages/open-code-bridge` | `experimental` | OpenCode compatibility facade governed by divergence budget |
| `orchestration` | ts-package | `packages/orchestration` | `experimental` | Expected-value subagent scheduler, isolated candidate workspaces, clean-context reviewers, stagnation supervisor with 11-signal intervention ladder |
| `policy-coordinator` | ts-package | `packages/policy-coordinator` | `experimental` | Bridges task contracts and kernel capability requests |
| `provider-anthropic` | ts-package | `packages/provider-anthropic` | `experimental` | Provider renderer; golden/live conformance not recorded at HEAD |
| `provider-cache` | ts-package | `packages/provider-cache` | `experimental` | Provider cache accounting |
| `provider-core` | ts-package | `packages/provider-core` | `experimental` | Provider-neutral broker/capability snapshots/cost accounting |
| `provider-economics` | ts-package | `packages/provider-economics` | `experimental` | Cost models/analytics |
| `provider-google` | ts-package | `packages/provider-google` | `experimental` | Provider renderer; conformance not recorded at HEAD |
| `provider-local` | ts-package | `packages/provider-local` | `experimental` | Local/open-weight provider renderer; conformance not recorded at HEAD |
| `provider-openai` | ts-package | `packages/provider-openai` | `experimental` | Provider renderer; conformance not recorded at HEAD |
| `public-client` | ts-package | `packages/public-client` | `experimental` | Generated-style TS client with SSE subscription |
| `remote` | ts-package | `packages/remote` | `experimental` | Remote execution types/clients |
| `session-runtime` | ts-package | `packages/session-runtime` | `experimental` | Session/thread/turn services; context epoch lifecycle |
| `task-runtime` | ts-package | `packages/task-runtime` | `experimental` | Task lifecycle/contract versioning/scope ledger |
| `terminus-kernel-client` | ts-package | `packages/terminus-kernel-client` | `experimental` | Typed kernel RPC client |
| `verification` | ts-package | `packages/verification` | `experimental` | Verification DAG engine with predicate tests; completion-gate conformance unproven at HEAD |
| `workflow-compiler` | ts-package | `packages/workflow-compiler` | `experimental` | Workflow IR, owner-test classifier, static validation suite, and deterministic controller (Phase 7) |
| `terminus-artifacts` | rust-crate | `crates/terminus-artifacts` | `preview` | CAS sha256 layout, atomic rename+fsync, SQLite metadata bridge tests |
| `terminus-fs` | rust-crate | `crates/terminus-fs` | `preview` | Safe path resolution; traversal/symlink rejection tests |
| `terminus-kernel-protocol` | rust-crate | `crates/terminus-kernel-protocol` | `preview` | Codegen'd protocol types + error codes with unit tests |
| `terminus-patch` | rust-crate | `crates/terminus-patch` | `preview` | Transactional edit engine with journal/snapshot/rollback tests |
| `terminus-policy` | rust-crate | `crates/terminus-policy` | `preview` | Strictest-wins command policy engine with unit tests |
| `terminus-process` | rust-crate | `crates/terminus-process` | `preview` | Process groups, bounded capture w/ artifact spill, timeouts; worker primitive |
| `terminus-sandbox` | rust-crate | `crates/terminus-sandbox` | `preview` | Backend trait + tier policy + secure-mode fail-closed selection + effective-control probes (ADR-0035) |
| `config` | ts-package | `packages/config` | `preview` | Layered typed configuration with JSON Schema codegen |
| `domain` | ts-package | `packages/domain` | `preview` | Canonical types/state machines/typed errors consumed by every package |
| `public-api` | ts-package | `packages/public-api` | `preview` | HTTP API definitions/error envelope/SSE with generated client surface |
| `runtime-protocol` | ts-package | `packages/runtime-protocol` | `preview` | Semantic event types + SSE codec with tests |

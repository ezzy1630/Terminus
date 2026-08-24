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
| `testkit` | ts-package | `packages/testkit` | `fixture` | Explicit fixture-only provider/kernel builders with grant references; never a production success path |
| `adapter-claude-code` | adapter | `adapters/claude-code` | `stub` | Contract-stub runner (protocol only, no inner harness launch, lastVerified null) |
| `adapter-codex` | adapter | `adapters/codex` | `stub` | Contract-stub runner returns completed without invoking Codex (audit 4.9) |
| `adapter-oh-my-pi` | adapter | `adapters/oh-my-pi` | `stub` | adapter.yaml declaration only; runner not implemented |
| `adapter-omnigent` | adapter | `adapters/omnigent` | `stub` | adapter.yaml declaration only; runner not implemented |
| `adapter-openhands` | adapter | `adapters/openhands` | `stub` | adapter.yaml declaration only; runner not implemented |
| `adapter-pi` | adapter | `adapters/pi` | `stub` | Contract-stub runner (protocol only, no inner harness launch, lastVerified null) |
| `terminus-extension-runtime` | rust-crate | `crates/terminus-extension-runtime` | `stub` | WASI extension host stub |
| `terminus-sandbox-microvm` | rust-crate | `crates/terminus-sandbox-microvm` | `stub` | Tier-3 backend selection skeleton: hypervisor detection + pinned rootfs + machine-config generation; fail-closed, EXPERIMENTAL per ADR-0027 |
| `terminus-sandbox-windows` | rust-crate | `crates/terminus-sandbox-windows` | `stub` | Native AppContainer intentionally absent (unsafe FFI needs dedicated ADR); fail-closed WSL2/container fallback only (ADR-0035 §5) |
| `app-cli` | app | `apps/cli` | `experimental` | Non-interactive task and Phase 9/10 operator commands; cross-client continuity unverified |
| `app-desktop` | app | `apps/desktop` | `experimental` | Electron cockpit has ten lazy decoded-data views and explicit offline states; fresh offline render tested, populated live flow and latency unverified |
| `app-ide-acp` | app | `apps/ide-acp` | `experimental` | TERMINUS_TOKEN-authenticated ACP-over-stdio adapter with typed context injection; editor-host conformance and native editor flows unverified |
| `app-tui` | app | `apps/tui` | `experimental` | TERMINUS_TOKEN-authenticated text-mode client with Phase 9 operator reads; interactive intervention, continuity, and usability exit gates unverified |
| `mini-service-control` | mini-service | `mini-services/terminus-control` | `experimental` | TS control plane persists local state and fails closed at an unconfigured provider transport; several Phase 9/10 coordinators remain process-local |
| `mini-service-kernel` | mini-service | `mini-services/terminus-kernel` | `experimental` | Rust kernel gRPC-over-private-UDS boundary; file resolution still uses one configured data root, so arbitrary registered-root isolation is unverified |
| `forge-evals` | python-package | `python/forge_evals` | `experimental` | Runners plus sealed Phase 11/12 structural contracts; no real held-out promotion, trusted signature verifier, canary, or dominance evidence |
| `terminus-authz` | rust-crate | `crates/terminus-authz` | `experimental` | Signed/scoped capability tokens real; revocation + nonce state in-memory (audit 4.4) |
| `terminus-code-intel` | rust-crate | `crates/terminus-code-intel` | `experimental` | Tree-sitter symbol index with basic tests |
| `terminus-connector` | rust-crate | `crates/terminus-connector` | `experimental` | L7 connector broker: grant-bound credential injection, exact-operation binding, rustls HTTPS with pinned resolved addresses, bounded response capture, and response scrubbing; real-account inference conformance is not recorded at HEAD |
| `terminus-egress` | rust-crate | `crates/terminus-egress` | `experimental` | L4 broker real (DNS/IP/port/scheme/bytes); no L7 intent semantics yet (audit 4.7) |
| `terminus-git` | rust-crate | `crates/terminus-git` | `experimental` | Protected worktree/commit/merge operations, small test set |
| `terminus-jobs` | rust-crate | `crates/terminus-jobs` | `experimental` | Useful supervision but job state is process-local; durability claims prohibited until Phase 2 substrate exists (audit 4.5) |
| `terminus-kernel` | rust-crate | `crates/terminus-kernel` | `experimental` | Service assembly substantive (13 service groups); full non-bypassability not proven at HEAD (no CI run) |
| `terminus-remote` | rust-crate | `crates/terminus-remote` | `experimental` | Execution pool + digest-pinned image primitives |
| `terminus-sandbox-container` | rust-crate | `crates/terminus-sandbox-container` | `experimental` | Hardened OCI profiles with argv-proven enforcement report; permissive mode stays Degraded (ADR-0035 §3) |
| `terminus-sandbox-linux` | rust-crate | `crates/terminus-sandbox-linux` | `experimental` | Strongest platform path (real bwrap argv); needs current signed conformance evidence at HEAD |
| `terminus-sandbox-macos` | rust-crate | `crates/terminus-sandbox-macos` | `experimental` | Seatbelt profile generation and env -i payload allowlist exist in source; no current candidate-bound conformance evidence (ADR-0035 §4) |
| `terminus-secrets` | rust-crate | `crates/terminus-secrets` | `experimental` | Opaque ConnectorGrants, residue scanner, and exact-URI OS credential-store provider; raw-value API crate-private, InMemoryProvider fixture-only (ADR-0035 §1, ADR-0044) |
| `aci` | ts-package | `packages/aci` | `experimental` | Agent-Computer Interface tools; unproven at HEAD |
| `adapter-sdk` | ts-package | `packages/adapter-sdk` | `experimental` | Stdio JSON-RPC adapter SDK; maturity gate added in Phase 0; live probes never run |
| `artifact-client` | ts-package | `packages/artifact-client` | `experimental` | Artifact ingest/get/link/gc client |
| `capability-registry` | ts-package | `packages/capability-registry` | `experimental` | Skills/MCP/plugins activation lifecycle |
| `context-compiler` | ts-package | `packages/context-compiler` | `experimental` | 16-step assembly algorithm; manifest reproduction not proven end-to-end at HEAD |
| `context-ir` | ts-package | `packages/context-ir` | `experimental` | Fragment/source-descriptor types |
| `extension-host` | ts-package | `packages/extension-host` | `experimental` | WASI/process hosts, hook semantics |
| `memory` | ts-package | `packages/memory` | `experimental` | Extraction/consolidation/retrieval with unit tests; promotion gates unproven on cohorts |
| `model-router` | ts-package | `packages/model-router` | `experimental` | Provider-neutral profile references, empirical posteriors, deterministic routing, rate limits, circuit breaker, and continuation; live-provider benefit unproven |
| `observability` | ts-package | `packages/observability` | `experimental` | OTel spans/logging/metrics wrappers |
| `orchestration` | ts-package | `packages/orchestration` | `experimental` | Phase 8 scheduling plus Phase 9/10 typed coordinators; governed browser, desktop, connector, and intervention executors are not integrated |
| `policy-coordinator` | ts-package | `packages/policy-coordinator` | `experimental` | Bridges task contracts and kernel capability requests |
| `provider-anthropic` | ts-package | `packages/provider-anthropic` | `experimental` | Provider renderer; golden/live conformance not recorded at HEAD |
| `provider-cache` | ts-package | `packages/provider-cache` | `experimental` | Provider cache accounting |
| `provider-core` | ts-package | `packages/provider-core` | `experimental` | Provider-neutral broker/capability snapshots/cost accounting |
| `provider-economics` | ts-package | `packages/provider-economics` | `experimental` | Cost models/analytics |
| `provider-google` | ts-package | `packages/provider-google` | `experimental` | Provider renderer; conformance not recorded at HEAD |
| `provider-local` | ts-package | `packages/provider-local` | `experimental` | Local/open-weight provider renderer; conformance not recorded at HEAD |
| `provider-openai` | ts-package | `packages/provider-openai` | `experimental` | Provider renderer; conformance not recorded at HEAD |
| `provider-zen` | ts-package | `packages/provider-zen` | `experimental` | Zen and Go renderers, catalog decoder, normalized transport, and kernel gateway wiring have focused tests; real-account inference conformance is not recorded at HEAD |
| `public-client` | ts-package | `packages/public-client` | `experimental` | Typed HTTP/SSE client with bearer auth and idempotent mutation support; independent-runtime conformance unproven |
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
| `public-api` | ts-package | `packages/public-api` | `preview` | HTTP/SSE contracts include typed Phase 9/10 resources and receipt references; trusted computer-use/DLP backends remain absent and fail closed |
| `runtime-protocol` | ts-package | `packages/runtime-protocol` | `preview` | Semantic event types + SSE codec with tests |

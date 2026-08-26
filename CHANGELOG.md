# Changelog

All notable changes to Terminus are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- `@terminus/permissions` — declarative ask/allow/deny tool permission engine with glob pattern matching and remembered session approvals (ADR-0045).
- `crates/terminus-patch` — tolerant anchor resolution fallback chain for exact-text file edits (ADR-0046).
- `@terminus/rollout` — canonical session rollout trajectory projection, JSONL encoder, and `GET /v1/sessions/:id/rollout` endpoint (ADR-0047).
- `@terminus/aci` — interactive `question` tool definition and executor for user decisions (ADR-0048).
- `@terminus/cron` — deterministic UTC cron/interval scheduling engine with `/v1/cron` management routes (ADR-0049).
- `@terminus/adapter-sdk` — lifecycle hooks contract, dispatcher, and 128KB payload size bounds (ADR-0050).
- `@terminus/lsp` — Language Server Protocol client, server registry, and root discovery (ADR-0051).
- `@terminus/context-compiler` — instruction discovery hardening with `AGENTS.override.md` precedence, fallback filenames, and explicit truncation markers.
- `mini-services/terminus-control` — doom-loop guard in coding turn engine detecting repeated identical tool calls.
- `@terminus/aci` — populated truncation continuation referencing immutable artifact URIs on stdout spills.

### Changed

- Terminus now owns ARP, the public API, and the public client directly. ADR-0039 retires the OpenCode bridge, source pin, overlays, divergence tooling, and fork release gates.
- `just standalone-check` blocks first-party OpenCode runtime/build dependencies. Historical research and external comparison baselines remain separate from the workspace.
- Checkpoints are now derived from authoritative server state and admitted only after canonical schema, SHA-256, task-contract, and durable artifact-owner validation. Caller-authored checkpoint state is rejected.
- Public effect transitions, including denial and cancellation, remain unchanged unless a trusted receipt boundary verifies the requested state.
- `ArtifactIngestService.Link` adds a capability-checked, reference-aware retention contract to the kernel gRPC API.

## [0.1.0] — unreleased

### Summary

Initial monorepo build of Terminus, a provider-neutral coding-agent operating system with a non-bypassable Rust effect kernel, an inspectable Context Compiler, evidence-based completion, and an eval gate for complexity. This is a development release — not for production use.

### Added — Rust kernel (115 tests passing)

- `crates/terminus-kernel` — privileged server and service assembly.
- `crates/terminus-kernel-protocol` — Protobuf-derived kernel protocol types and error codes.
- `crates/terminus-authz` — capability tokens and authorization.
- `crates/terminus-policy` — normalized effect policy engine with YAML rule sets.
- `crates/terminus-sandbox` (+ linux/macos/windows/container backends) — sandbox trait, profile, manager, reports.
- `crates/terminus-process` — exec, PTY, process trees, resource limits, structured `CommandSpec`.
- `crates/terminus-jobs` — durable job state, recovery, records.
- `crates/terminus-fs` — safe path resolution and snapshots.
- `crates/terminus-patch` — edit planning, staging, journal, rollback, validation.
- `crates/terminus-artifacts` — content-addressed store, metadata, GC.
- `crates/terminus-secrets` — capability broker, redaction, audit.
- `crates/terminus-egress` — proxy and destination policy.
- `crates/terminus-code-intel` — Tree-sitter/LSP/DAP facade, symbols, index, inspect.
- `crates/terminus-extension-runtime` — WASI/process extension host, manifest validation.
- `crates/terminus-git` — protected worktree/commit/merge operations.
- `crates/terminus-kernel-testkit` — mock sandbox, fake kernel, builders, store.

### Added — TypeScript control plane

- `packages/domain`, `public-api`, `public-client`, `session-runtime`, `task-runtime`, `context-ir`, `context-compiler`, `retrieval`, `provider-core`, `provider-openai/anthropic/google/local`, `model-router`, `orchestration`, `verification`, `memory`, `capability-registry`, `extension-host`, `adapter-sdk`, `policy-coordinator`, `artifact-client`, `observability`, `config`, `testkit`.

### Added — Next.js dashboard (5,283 lines)

- `src/app/page.tsx` — Terminus Control Plane dashboard on port 3000.
- Caddy gateway with `?XTransformPort=` routing to mini-services.

### Added — Python evaluation laboratory (12,711 lines, 158 tests passing)

- `python/forge_evals/` — runners, graders (end_state, acceptance, security, conformance), analysis, statistics (paired, bootstrap, multiple comparisons, effect size, non-inferiority), dashboards, research (context/aci/orchestration ablations), 19 cohort task catalogs, 8 baselines, RunRecord, experiment manifest, promotion gate, CLI.

### Added — Declarative configuration (125 fixture files)

- `skills/builtin/` — 6 Agent Skills format skills with `terminus.skill.yaml` and computed `skill_md_hash`.
- `skills/fixtures/malicious/` — prompt-injection test fixture.
- `capability-packs/` — 8 capability packs (web-browser, github, gitlab, database, cloud-deploy, debugger, notebooks, images).
- `policies/` — secure-local-default, degraded-local, container-untrusted, command/network/secrets/organizations defaults.
- `prompts/` — authority, provider-renderers, checkpoint, delegation, review, memory.
- `schemas/` — domain (5), events catalog (31 event types), tools (7), capabilities (4).
- `evals/` — 4 complete task packages, 3 environment locks, 2 graders, 5 security evals, 2 baselines, 3 suites.
- `adapters/` — 7 external harness adapter profiles (codex, claude-code, pi, oh-my-pi, omnigent, openhands, fixture-agent).

### Added — Toolchain and governance

- `mise.toml`, `justfile`, `deny.toml`, `buf.yaml`, `buf.gen.yaml`, `pnpm-workspace.yaml`.
- `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/CODEOWNERS`, `.github/pull_request_template.md`.
- `proto/terminus/kernel/v1/kernel.proto` — canonical kernel RPC schema.
- `migrations/sqlite/0001_initial.sql` — initial schema with STRICT tables.
- `AGENTS.md`, `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `README.md`.
- ADRs, architecture documents, runbooks, and product/security/quality/research plans; current counts live in `docs/generated/inventory.md`.

### Mini-services

- `mini-services/terminus-kernel/` — Rust privileged effect kernel on port 3040.
- `mini-services/terminus-control/` — TypeScript control-plane realtime + provider loop on port 3050.

### Known limitations

- This is a development build. Many subsystems are scaffolds with unit tests but no full integration path.
- Durable memory is disabled by default pending the precision/harm gate (ADR-0023).
- Native Windows AppContainer enforcement is absent; Windows fails closed to the documented fallback.
- Shared multi-tenant kernel execution remains deferred (ADR-0030).
- External harness adapters and release evaluations remain fixture/stub tier until independently pinned live runs exist.
- Stable release remains blocked on exact-commit signed Linux evidence, owner signatures, release-tier evaluations, and the full required security suite.

[0.1.0]: https://github.com/terminus/terminus/releases/tag/v0.1.0

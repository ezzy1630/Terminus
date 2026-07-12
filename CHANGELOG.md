# Changelog

All notable changes to Terminus are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

### Added — TypeScript control plane (26 packages, ~11k lines)

- `packages/domain`, `public-api`, `public-client`, `open-code-bridge`, `session-runtime`, `task-runtime`, `context-ir`, `context-compiler`, `retrieval`, `provider-core`, `provider-openai/anthropic/google/local`, `model-router`, `orchestration`, `verification`, `memory`, `capability-registry`, `extension-host`, `adapter-sdk`, `policy-coordinator`, `artifact-client`, `observability`, `config`, `testkit`.

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
- 30 ADRs in `docs/decisions/` per Appendix H inventory.
- 9 architecture docs, 12 runbooks, product/security/quality/research/plans docs.
- `upstream/opencode.lock.json`, `upstream/divergence-budget.yaml`, `upstream/patches/`.

### Mini-services

- `mini-services/terminus-kernel/` — Rust privileged effect kernel on port 3040.
- `mini-services/terminus-control/` — TypeScript control-plane realtime + provider loop on port 3050.

### Known limitations

- This is a development build. Many subsystems are scaffolds with unit tests but no full integration path.
- Bun is still required for the upstream OpenCode bridge (ADR-0026 PROVISIONAL).
- Durable memory is disabled by default pending the precision/harm gate (ADR-0023).
- Container/micro-VM backend selection is OPEN (ADR-0027).
- Remote multi-tenant deployment is OPEN (ADR-0030).
- 158/175 Python eval tests pass; remaining failures are test-fixture edge cases.

### Upstream divergence

- Pinned OpenCode commit recorded in `upstream/opencode.lock.json`.
- Divergence budget tracked in `upstream/divergence-budget.yaml`.

[0.1.0]: https://github.com/terminus/terminus/releases/tag/v0.1.0

# Forge

[![CI](https://img.shields.io/badge/CI-pending-lightgrey)](.github/workflows/ci.yml)
[![Spec](https://img.shields.io/badge/SPEC.md-50%20sections%2C%2011%20appendices-blue)](SPEC.md)
[![License](https://img.shields.io/badge/license-Apache--2.0%20%7C%20MIT-green)](LICENSE)
[![Status](https://img.shields.io/badge/status-development-orange)](CHANGELOG.md)

**Forge** is a provider-neutral coding-agent operating system with a non-bypassable Rust effect kernel, an inspectable Context Compiler, evidence-based completion, and an eval gate for complexity. It is local-first: a UI process may disconnect without stopping a task, a model provider may change between compatible turns, and a worker may crash and be reconciled — but a task is never complete solely because a model produced a completion statement.

The durable product is the combination of a task/session runtime, a canonical Context Compiler, a provider-neutral model broker, a non-bypassable effect kernel, an artifact and evidence store, a verification engine, a capability-secured extension system, a selective agent scheduler, client surfaces, and an offline evaluation laboratory. See `SPEC.md` for the normative contract and `docs/architecture/overview.md` for the layered diagram.

## Architecture

```
CLIENTS  (TUI · CLI · Web · Desktop · IDE/ACP · SDK · CI · Remote supervisor)
   │ Public API / ACP adapter
CONTROL AND COGNITION PLANE — TypeScript, OpenCode-derived initially
   │ privileged effects RPC          │ unprivileged capability RPC
EXECUTION/SECURITY MICROKERNEL        CAPABILITY PLANE
(Rust, non-bypassable)               (built-in tools, skills, MCP, plugins, adapters)
   │
WORKSPACES (local worktrees · containers · gVisor · micro-VMs · remote sandboxes)

EVIDENCE/EVAL/EVOLUTION PLANE  ·  DATA PLANE (SQLite/WAL · events · CAS · Git · OTel · Parquet)
```

See `docs/architecture/overview.md` for the full diagram and `docs/architecture/trust-boundaries.md` for the trust-zone model (Z0–Z5).

## Quickstart

```bash
# 1. Install mise and bootstrap the pinned toolchain.
curl https://mise.run | sh
just bootstrap

# 2. Build everything.
just codegen-check && just build

# 3. Run the mini-services + dashboard (3 terminals).
just run-kernel   # Rust kernel on :3040
just run-control  # TS control plane on :3050
just run-tui      # Next.js dashboard on :3000
```

Open <http://localhost:3000> for the Forge Control Plane dashboard. The Caddy gateway routes to mini-services via `?XTransformPort=3040` or `?XTransformPort=3050`.

Or run all three supervised: `just run`.

## What's built

| Component | Status | Tests |
|---|---|---|
| Rust kernel (19 crates) | Scaffolded | 115 passing |
| TS control plane (26 packages, ~11k lines) | Scaffolded | — |
| Next.js dashboard (5,283 lines) | Scaffolded | — |
| Python eval lab (12,711 lines) | Functional | 158/175 passing |
| Declarative config (skills, policies, prompts, schemas, evals, adapters) | 125 files | YAML/JSON validated |
| Governance (30 ADRs, runbooks, security docs) | This task | — |

See `CHANGELOG.md` for the full 0.1.0 inventory.

## Documentation

- `SPEC.md` — the normative specification (9,550 lines).
- `docs/architecture/` — subsystem deep dives.
- `docs/decisions/` — 30 ADRs from Appendix H.
- `docs/runbooks/` — operational runbooks.
- `docs/security/` — threat model, bypass register, non-bypassability tests.
- `docs/plans/roadmap.md` — milestones M0–M12.
- `docs/plans/pr-sequence.md` — first 40 PRs.

## License

Dual-licensed under Apache-2.0 and MIT (see `LICENSE`). Third-party licenses are audited by `cargo deny` (see `deny.toml`) and `npm audit`.

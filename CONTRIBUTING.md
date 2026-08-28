# Contributing to Terminus

Thanks for your interest in contributing to Terminus. This guide covers setup, code style, the pull-request template, ownership, and review requirements.

## Setup

```bash
# 1. Install mise (manages Rust, Node, Bun, Python, uv, buf, just).
curl https://mise.run | sh

# 2. Bootstrap pinned toolchain and dependencies.
just bootstrap

# 3. Verify the environment.
just codegen-check
just check
```

Required tools (pinned in `mise.toml`):

- Rust 1.97.0 (stable)
- Node 22.x LTS
- pnpm (workspace), Bun 1.3.x (development and test runner)
- Python 3.12.13 with `uv`
- `buf`, `just`, `cargo-deny`, `sqlx-cli`

See `mise.toml` for exact versions and `rust-toolchain.toml` for the Rust toolchain.

## Repository layout

See `SPEC.md` §42.1 for the normative monorepo layout. Quick map:

- `crates/` — Rust workspace (privileged effect kernel).
- `packages/` — TypeScript workspace (control plane, context, providers, orchestration).
- `python/forge_evals/` — offline evaluation laboratory (compatibility import path; ADR-0052).
- `mini-services/` — kernel (port 3040) and control (port 3050) mini-services.
- `apps/` — TUI/CLI/web/desktop/IDE clients.
- `proto/` — Protobuf source of truth for kernel RPC.
- `schemas/` — JSON Schema sources for domain/events/tools/capabilities.
- `policies/`, `prompts/`, `skills/`, `capability-packs/`, `evals/`, `adapters/` — declarative configuration.
- `docs/` — architecture, decisions (ADRs), runbooks, security, quality, plans.
- `migrations/sqlite/` — schema migrations.

## Code style

### Rust (SPEC §44.2)

- `cargo fmt --all` (rustfmt).
- `cargo clippy --workspace --all-targets -- -D warnings` (clippy pedantic + nursery).
- No `unsafe`, `unwrap`, `expect`, `panic` in production paths (lints deny these).
- Typed errors via `thiserror`; no stringly-typed failures.
- Cancellation-aware; no blocking I/O on async executors; no unbounded channels.

### TypeScript (SPEC §44.3)

- `eslint` + `tsc --noEmit` with strict compiler options (see `tsconfig.base.json`).
- No `any` outside generated/compatibility code.
- Validate all external input at runtime with Effect schemas or zod.
- No import-time side effects.

### Python (SPEC §44.4)

- `ruff format` + `ruff check`.
- `mypy --strict` (or pyright strict).
- Deterministic seeds; versioned graders; no p-value-only conclusions.

## Pull-request template (SPEC §49.2)

See `.github/pull_request_template.md`. Every PR description includes:

```markdown
## Objective

## Contract / acceptance criteria

## Why this change is needed

## Design and alternatives

## Security and privacy impact

## Protocol/schema/migration impact

## Tests and evidence

## Agent/eval impact

## Rollback or feature flag

## Standalone dependency impact
```

## Ownership matrix (SPEC §49.3)

| Area | Primary | Required reviewers |
|---|---|---|
| Public protocol | protocol owner | client + compatibility owner |
| Kernel protocol | runtime owner | protocol + security owner |
| Sandbox/policy/secrets/network | security runtime | two security/runtime reviewers |
| Context compiler | context owner | evaluation owner |
| Provider adapters | provider owner | context + privacy reviewer |
| ACI/patch/search | ACI owner | runtime + evaluation |
| Orchestration | orchestration owner | verification + evaluation |
| Memory | memory owner | privacy + evaluation |
| MCP/plugins/adapters | ecosystem owner | security owner |
| Storage/migrations | persistence owner | recovery owner |
| Standalone dependency boundary | architecture owner | affected package owner |
| Release | release owner | security + protocol + eval owners |

See `.github/CODEOWNERS` for the current repository owner.

## Review requirements (SPEC §44.8)

A change requires review from:

- the package owner;
- the security owner for policy, sandbox, secret, network, plugin, MCP, auth, or multi-tenant changes;
- the protocol owner for public/proto/schema changes;
- the evaluation owner for default policy/model/context changes;
- the architecture owner for standalone dependency-boundary changes.

**High-risk changes require two approvals and passing targeted security/eval suites.**

## Definition of done (SPEC §44.9)

A PR is done when:

- scope and acceptance criteria are stated;
- implementation follows dependency boundaries (`crates/`, `packages/`, no cycles);
- tests cover success and failure;
- generated files are current (`just codegen-check` clean);
- docs/ADRs are updated;
- telemetry is added or intentionally unnecessary;
- security and privacy impact are considered;
- migrations and rollback are defined;
- feature flag/default status is explicit;
- benchmark/eval impact is measured when behavior affects agents;
- release notes are included for user-visible changes.

## Adding new ADRs

```bash
just new-adr title="short-kebab-title"
```

ADRs live in `docs/decisions/`. Use the template (Context, Decision, Status, Alternatives, Consequences, Security Impact, Evaluation Plan, Migration, Rollback). Status is one of `ADOPTED`, `PROVISIONAL`, `EXPERIMENTAL`, `DEPRECATED`, `REJECTED`, `OPEN` (SPEC §26.7).

## Adding new packages/crates

```bash
just new-ts-package name=...
just new-rust-crate name=...
just new-tool id=...
just new-event type=...
just new-capability id=...
just new-adapter id=...
just new-eval suite=... task=...
```

Scaffolds include README, AGENTS, tests, ownership, lint config, observability placeholders, and CI registration (SPEC §45.7).

## Standalone dependency boundary

First-party runtime/build code must not import or depend on OpenCode. External harness integrations use the adapter protocol. Run `just standalone-check` for every dependency, workspace, client, or protocol change.

## Questions

- Architecture: `docs/architecture/`.
- Decisions: `docs/decisions/`.
- Operations: `docs/runbooks/`.
- Security: `SECURITY.md` and `docs/security/`.

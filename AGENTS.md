# Terminus repository instructions

## Mission

Build a provider-neutral coding-agent operating system with a non-bypassable Rust effect kernel, an inspectable Context Compiler, evidence-based completion, and an eval gate for complexity. The durable product is its contracts, context manifests, evidence, and Rust effect boundary—not any client, provider adapter, or extension.

## Source-of-truth order

Before changing code, read only the material relevant to the task:

1. Scoped `AGENTS.md` files from the repository root through the working directory.
2. The applicable sections of `SPEC.md`, which is normative.
3. The package or crate `README.md`.
4. Applicable adopted `docs/decisions/ADR-*.md` files and subsystem documents under `docs/architecture/`.
5. Applicable `docs/runbooks/` documents when operating production behavior.

When these sources disagree, stop and surface the conflict. Do not silently choose one.

## Hard boundaries

- Route TypeScript process execution, filesystem mutation, socket access, and secret access through the kernel RPC (`terminus.kernel.v1` over UDS). Exceptions require an adopted ADR and an explicitly documented bridge boundary.
- Keep provider request bodies and provider-specific model concepts inside `packages/provider-*`; canonical domain packages remain provider-neutral.
- Do not declare completion without verification evidence mapped to the task's acceptance criteria.
- Product code must not silently truncate bounded output. State that truncation occurred and expose a continuation token or immutable artifact reference. When running local commands, byte-cap uncertain output and inspect the relevant continuation or failing tail.
- Do not edit generated files directly. Run `just codegen`, then `just codegen-check`.
- Do not enable a default affecting context, tools, routing, compression, memory, or orchestration without a targeted evaluation or a documented security/reliability justification.
- Do not widen task scope without updating the task contract and scope ledger. Obtain user approval when the effective scope expands.
- Never expose raw credentials in prompts, logs, artifacts, fixtures, or tests. Use short-lived brokered capabilities.
- Before modifying inherited OpenCode files, identify them through `upstream/divergence-budget.yaml`; update that file and `docs/security/effect-bypass-register.yaml` with the change.
- Production Rust must not use `unwrap`, `expect`, or `panic`, unbounded channels, or detached `tokio::spawn`. Narrowly scoped `unsafe` is allowed only under SPEC §44.2: adopted ADR, safety comment, applicable Miri/fuzz coverage, and security-owner review.
- TypeScript `any` is prohibited outside generated and compatibility code. Decode `unknown` at boundaries.

## Change workflow

For behavioral code changes:

1. State the objective, acceptance criteria, and allowed scope before implementation.
2. Inspect existing interfaces and tests.
3. Update the schema or ADR first when the contract changes.
4. Add a failing or characterizing test for the intended invariant.
5. Implement one reviewable contract or vertical slice.
6. Run targeted checks during development.
7. Before handoff, run `just check`, the applicable suites below, and `just codegen-check`.
8. Report the diff, evidence, risks, and upstream impact.

Do not generate a whole subsystem in one change. Prefer one independently testable contract or vertical slice per PR.

## Verification matrix

Apply the relevant rows to behavioral changes. Documentation-only or mechanical changes need proportionate validation.

- **Domain/state:** unit and property tests.
- **Protocol/schema:** codegen and current×previous compatibility.
- **Kernel/effects:** integration, recovery, and adversarial security tests.
- **Agent behavior:** targeted `eval-smoke` and the changed cohort.
- **Provider renderer:** exact golden tests and live conformance where permitted.
- **Storage migration:** upgrade and rollback/recovery drill.
- **Extension/MCP:** isolation and malicious fixtures, including poisoned descriptors and rug-pulls.

Changes to policy, sandboxing, secrets, network access, plugins, MCP, auth, multi-tenancy, or public protocols require passing targeted security/eval suites and two approvals before merge.

## Common commands

```text
just check            # fast lint, type, and unit checks
just codegen-check    # verify generated files have no drift
just check-all        # full local validation
just release-check    # release gate
just --list           # all build, test, eval, and run recipes
```

## Pull requests

Use `.github/pull_request_template.md`. Before opening a PR, record the objective and acceptance criteria there, then include verification evidence, security/privacy impact, rollback or feature-flag status, protocol/schema/migration impact, agent/eval impact, and upstream divergence impact.

A PR is done only when its acceptance criteria have evidence, success and failure paths are tested where applicable, generated files are current, documentation and ADRs match the implementation, security/privacy and migration/rollback impacts are explicit, agent-behavior changes have evaluation evidence, and user-visible changes have release notes.

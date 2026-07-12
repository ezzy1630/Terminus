# Terminus repository instructions

## Mission

Build a provider-neutral coding-agent operating system with a non-bypassable Rust effect kernel, an inspectable Context Compiler, evidence-based completion, and an eval gate for complexity. The durable product is the combination of contracts, context manifests, evidence, and the Rust effect boundary — not any particular client, provider adapter, or extension.

## Read first

1. `SPEC.md` (normative; 50 sections, 11 appendices).
2. The package/crate `README.md` you are working in.
3. Applicable `docs/decisions/ADR-*.md` (status from Appendix H).
4. Scoped `AGENTS.md` files from root down to the working directory.
5. `docs/architecture/*.md` for the subsystem you are touching.
6. `docs/runbooks/*.md` if operating production behavior.

## Non-negotiable rules

- Do not add direct process spawn, filesystem mutation, socket, or secret access to TypeScript code. Route through the kernel RPC (`terminus.kernel.v1` over UDS).
- Do not place provider-specific request bodies or model concepts in canonical domain packages. Provider code lives in `packages/provider-*` only.
- Do not mark a task complete without verification evidence linked to acceptance criteria.
- Do not silently truncate tool output. Every bounded result states truncation and exposes a continuation or immutable artifact reference.
- Do not edit generated files directly. Regenerate via `just codegen` and check drift via `just codegen-check`.
- Do not add a default feature affecting context, tools, routing, compression, memory, or orchestration without a targeted evaluation or a hard security/reliability justification.
- Do not widen task scope without updating the contract and scope ledger.
- Do not expose raw credentials in prompts, logs, artifacts, fixtures, or tests. Secrets are short-lived brokered capabilities only.
- Do not modify inherited OpenCode files without updating `upstream/divergence-budget.yaml` and `docs/security/effect-bypass-register.yaml`.
- Do not commit `unsafe` Rust, `unwrap`/`expect`/`panic` in production paths, unbounded channels, or detached `tokio::spawn` without a supervising task group.
- Do not add `any` to TypeScript outside generated/compatibility code.

## Development flow

1. State objective and acceptance criteria in the PR description.
2. Inspect existing interfaces and tests before writing code.
3. Add/update schema or ADR first when the contract changes.
4. Add a failing or characterizing test for the intended invariant.
5. Implement the smallest vertical slice (one contract or vertical slice per PR).
6. Run `just check` (fast lint/type/unit).
7. Run targeted integration/security/eval commands for the affected area.
8. Run `just codegen-check` (no generated drift).
9. Summarize diff, evidence, risks, and upstream impact in the PR report.

## Commands

```text
just bootstrap        # install pinned tools/dependencies and verify environment
just build            # build Rust, TypeScript, and generated contracts
just check            # fast lint/type/unit checks
just check-all        # full local validation
just codegen          # regenerate all derived contracts
just codegen-check    # verify no generated drift
just unit             # all unit tests
just integration      # integration tests
just security         # local-capable security suite
just e2e              # end-to-end task tests
just eval-smoke       # small deterministic eval suite
just eval-full        # full configured evaluation suite
just upstream-check   # OpenCode parity and divergence checks
just release-check    # release gate
just run              # run control plane and kernel locally
just run-kernel       # kernel only (port 3040)
just run-control      # control plane only (port 3050)
just run-tui          # Next.js dashboard (port 3000)
```

## Code standards

### Rust (see SPEC §44.2)

- Workspace lints: `unsafe_code = "deny"`, `unused_must_use = "deny"`, `clippy::all = "deny"`, `clippy::pedantic = "warn"`, `clippy::unwrap_used/expect_used/panic = "deny"`.
- No `unsafe` without an ADR, safety comment, Miri/fuzz tests, and security-owner review.
- No blocking I/O on async executors; no unbounded channels; no detached tasks.
- Propagate cancellation; own subprocess trees; use safe path wrapper types.
- Use zeroizing types for raw secret material; errors carry stable codes and source context without leaking secrets.
- Public APIs have rustdoc examples.

### TypeScript (see SPEC §44.3)

- Strict compiler settings: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noImplicitReturns`, `useUnknownInCatchVariables`, `verbatimModuleSyntax`, `isolatedModules`, `moduleResolution: "Bundler"`.
- `any` prohibited outside generated/compatibility code; `unknown` decoded at boundaries.
- Exhaustive switches use `never` checks.
- No direct `child_process`, raw filesystem mutation, network socket, or secret environment access outside approved bridge modules.
- Async operations accept cancellation/abort signals; no import-time effects; immutable domain values by default.
- All model/provider outputs receive runtime validation; prompts and tool descriptions have version identifiers.

### Python (see SPEC §44.4)

- Evaluation/research only unless an ADR says otherwise. Never on the production enforcement path.
- Strict static typing (mypy/pyright strict); Ruff for formatting/linting.
- Deterministic seeds; versioned graders; no p-value-only conclusions.
- Reusable analysis moves into modules under `python/forge_evals/`.

## Tests required by change type

- **Domain/state:** unit + property.
- **Protocol/schema:** codegen + compatibility (current×previous).
- **Kernel/effects:** integration + recovery + security (adversarial).
- **Agent behavior:** targeted eval-smoke and changed-cohort eval.
- **Provider renderer:** golden exactness + live conformance where permitted.
- **Storage migration:** upgrade + rollback/recovery drill.
- **Extension/MCP:** isolation + malicious fixture (poisoned descriptor, rug-pull).

High-risk changes (policy, sandbox, secrets, network, plugin, MCP, auth, multi-tenant, public/proto) require two approvals and passing targeted security/eval suites.

## Pull request report

Every PR description follows `docs/decisions/ADR-0001`* template and `.github/pull_request_template.md`. Include:

- Objective
- Contract / acceptance criteria
- Why this change is needed
- Design and alternatives
- Security and privacy impact
- Protocol/schema/migration impact
- Tests and evidence
- Agent/eval impact
- Rollback or feature flag
- Upstream divergence impact

A PR is done (SPEC §44.9) when scope is stated, dependencies respected, tests cover success and failure, generated files current, docs/ADRs updated, telemetry added or unnecessary, security/privacy considered, migrations and rollback defined, feature flag/default status explicit, eval impact measured when behavior affects agents, and release notes included for user-visible changes.

Agents MUST NOT generate a whole subsystem in one unreviewable change (SPEC §45.8). Recommended maximum PR scope is one contract or vertical slice with independent tests.

# Terminus repository instructions

## Mission

Build a provider-neutral coding-agent operating system with a non-bypassable Rust effect kernel, an inspectable Context Compiler, evidence-based completion, and an eval gate for complexity. The durable product is its contracts, context manifests, evidence, and Rust effect boundary, not any client, provider adapter, or extension.

## Read current authority

Read only the sources relevant to the task, in this order:

1. Scoped `AGENTS.md` files from the repository root through the working directory.
2. Current source, tests, schemas, generated contracts, and the package or crate `README.md`.
3. Adopted `docs/decisions/ADR-*.md` files and the applicable current `docs/architecture/` document.
4. Applicable `docs/runbooks/` documents when operating production behavior.

Stop and surface disagreements between current source and adopted decisions. Do not silently choose one source. `SPEC.md` is partly stale; consult it only for relevant design intent and validate every used claim. Historical reports, `Terminus — Research`, task plans, agent memory, generated summaries, and old benchmark artifacts are leads, not current authority.

Use `maturity.yaml` for component maturity. Bind executed-test, platform, benchmark, and release claims to evidence from the exact commit. A fixture, static inventory, successful build, packaged artifact, or one live task does not prove production maturity, platform support, benchmark eligibility, superiority, or release readiness.

## Architectural boundaries

- Route TypeScript process execution, filesystem mutation, socket access, and secret access through kernel RPC (`terminus.kernel.v1` over UDS). An exception needs an adopted ADR and an explicit bridge boundary.
- Keep provider request bodies, wire formats, and provider-specific rendering inside `packages/provider-*`. Canonical domain and runtime packages stay provider-neutral.
- Fail closed when a required kernel, sandbox, provider transport, capability, or authoritative store is unavailable. Return a typed blocked/unavailable result; never substitute a fixture, synthetic response, rehearsal result, or weaker unnamed mode.
- Product code must state when bounded output was truncated and return a continuation token or immutable artifact reference.
- Never put raw credentials in prompts, logs, artifacts, fixtures, or tests. Use short-lived brokered capabilities.
- Keep first-party runtime and build paths independent of OpenCode. External harness integrations stay behind provider-neutral adapter protocols; verify this with `just standalone-check`.
- Do not enable a default that changes context, tools, routing, compression, memory, or orchestration without a targeted evaluation or a documented security or reliability justification.
- When effective task scope changes, update the task contract and scope ledger before implementation. Contract changes start with the schema or an adopted ADR.
- Do not edit generated files directly. Change their source and regenerate them. Narrowly scoped production Rust `unsafe` still requires an adopted ADR, a safety comment, applicable Miri or fuzz coverage, and security-owner review.

## Change and proof routing

For behavioral work, characterize the invariant, implement one reviewable contract or vertical slice, and run focused checks while iterating. Use the repository's pinned tools with `mise exec --`; do not substitute system tool versions.

The common gates have different meanings:

```text
mise exec -- just check          # format, lint, boundary, and type checks; not unit tests
mise exec -- just unit           # Rust, TypeScript, and Python unit tests
mise exec -- just check-all      # broad local gate; ends by requiring a clean tracked tree
mise exec -- just codegen-check  # regenerate twice; compare generated output with HEAD
mise exec -- just standalone-check # reject first-party OpenCode runtime/build coupling
mise exec -- just eval-smoke     # fixture plus local-runtime eval; not live-provider or release proof
mise exec -- just release-check  # release gate; requires external evidence and fails closed without it
mise exec -- just --list         # discover narrower recipes
```

`just check-all` can pass only after task changes are committed in a checkout with no unrelated tracked diffs because its final gate compares the tree with `HEAD`. If contract sources changed, run `just codegen`, review the generated paths, commit them with their sources, then require `just codegen-check`. A hung or interrupted generator is unverified.

Map extra proof to the changed boundary:

- Protocol or schema: codegen plus current-to-previous compatibility.
- Kernel or effects: integration, recovery, and adversarial security tests.
- Agent behavior or default policy: targeted eval and the changed cohort.
- Provider renderer: exact golden tests and live conformance when permitted.
- Storage migration: forward upgrade plus rollback or recovery.
- Extension or MCP: isolation and malicious fixtures.

Changes to policy, sandboxing, secrets, network access, plugins, MCP, auth, multi-tenancy, or public protocols require targeted security and eval suites plus two approvals before merge.

For desktop changes, build and launch the app from the exact checkout with `cd apps/desktop && mise exec -- bun run dev:electron:live`. Inspect the running window and the relevant loading, offline, error, and interaction states. A source diff, test, Vite build, control-runtime package, or stale Electron process is not visual proof.

Before handoff, inspect the task-owned diff and report the exact checkout and commit, commands and results, runtime surfaces exercised, evidence class, and every blocked or unverified acceptance gate. Do not convert partial local proof into a release, maturity, platform, or superiority claim.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

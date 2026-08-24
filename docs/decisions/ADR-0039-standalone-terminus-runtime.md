# ADR-0039: Standalone Terminus runtime

- **Status:** ADOPTED
- **Date:** 2026-08-23
- **Decision owner:** architecture owner
- **Supersedes:** ADR-0002
- **Related:** ADR-0003, ADR-0004, ADR-0026, SPEC §6, §42, §43

## Context

ADR-0002 chose an OpenCode fork as a temporary bootstrap source. Terminus now owns the contracts that were meant to survive that migration: the provider-neutral domain model, Agent Runtime Protocol (ARP), public API, public client, provider adapters, context compiler, evidence model, and Rust effect kernel. No first-party application or package depends on `@terminus/open-code-bridge` at runtime.

Keeping the bridge, source pin, overlays, divergence budget, and parity gates now adds a second architectural story without providing a product capability. Existing fork-gate and bypass documents contain repository declarations, not live proof that historical OpenCode behavior reached parity. They cannot justify a continuing dependency.

## Decision

Terminus is a standalone coding-agent runtime.

1. First-party runtime and build code MUST NOT import OpenCode code or declare an OpenCode workspace dependency.
2. Terminus owns the canonical client path directly: `@terminus/runtime-protocol` defines ARP, `@terminus/public-api` exposes ARP over the public boundary, and `@terminus/public-client` is the client dependency for first-party clients.
3. Provider request bodies stay in `packages/provider-*`. Privileged effects stay behind `terminus.kernel.v1`. Neither boundary may depend on an inherited compatibility layer.
4. The OpenCode bridge, pinned source metadata, overlays, divergence tooling, upstream CI, and fork release gates are removed. Ignored local data under `vendor/opencode/` is outside the build and may remain on a developer machine.
5. `just standalone-check` enforces the retired-path, import, workspace-dependency, and direct-ownership invariants. CI and release checks run it.
6. OpenCode may remain in research, design-reference, and evaluation-baseline material as a competitor or historical input. Those references MUST NOT imply a current runtime or build dependency.
7. The inherited effect-bypass register is retired with no active entries. Its retirement proves only that the inherited source paths are gone. It does not retroactively validate earlier parity or bypass-removal claims.
8. Standalone control/kernel bootstrap uses the restricted UDS transport, not a production wildcard capability. When explicitly enabled for the packaged standalone supervisor, `KernelInfoService.BootstrapControl` mints two short-lived capabilities bound to the Terminus control principal: an Admin broker capability bound to `control-broker`, and an Admin maintenance capability bound to `control-maintenance`. `PolicyService.MintTaskCapability` accepts only the broker capability and may mint only non-Admin, non-Policy capabilities bound to one concrete task/session/workspace. Ordinary effects and artifact reads use those task-scoped capabilities. The bootstrap RPC MUST NOT be exposed by the HTTP kernel adapter or a TCP listener.
9. The packaged Electron main process may supervise only the two Terminus-owned
   executables embedded in its signed resources: `terminus-kernel-mini` and the
   matching `terminus-control` runtime. This is a narrow bootstrap exception to
   the TypeScript process-effect rule because no running kernel exists yet to
   start itself. The supervisor resolves fixed resource-relative paths, verifies
   the commit-bound runtime manifest and file digests before execution, uses
   explicit argv without a shell, creates owner-only state, generates fresh
   process-local secrets, runs checksum-verified migrations before listen, and
   stops both children with the application. It exposes no command, environment,
   token, or process handle to the renderer. Provider commands and every task
   effect still cross the kernel RPC and are not part of this exception.
10. The durable local-provider configuration is credential-free and
    revision-checked. Tool use is disabled by default and may expose only the
    standalone `read`, exact-text `patch`, and bounded `exec` contracts. The
    provider may emit at most one tool call per response and a turn may settle
    at most four tool calls. Every call is validated, policy-recorded, and
    dispatched through `terminus.kernel.v1`; no provider-selected shell,
    environment, secret, network destination, or ambient path is accepted.
11. A settled tool call and its result are persisted as a complete,
    model-visible episode pair before another provider attempt begins. The
    next attempt recompiles an exact context manifest from the durable artifact
    bytes and verifies their content hashes. Dispatched write/exec calls that
    lose settlement certainty become `UNKNOWN`/`MANUAL_REVIEW` and are never
    retried automatically. Tool-cycle or result-size exhaustion fails closed
    with an explicit continuation or immutable artifact reference.

## Alternatives

- **Keep a dormant bridge.** Rejected because it leaves an unsupported compatibility boundary in the workspace and lets future code depend on it accidentally.
- **Vendor OpenCode as an external runtime.** Rejected because it would restore a second session, client, provider, and effect architecture.
- **Retain parity gates for reference.** Rejected because tests against a retired implementation do not verify the Terminus public path.

## Consequences

- ARP, the public API, and the public client have explicit Terminus-owned dependency edges.
- Upstream pinning, divergence budgets, overlay maintenance, and inherited-client compatibility are no longer release concerns.
- ADR-0026's bridge exception is retired. First-party packages remain Node-compatible, while Bun may continue as a pinned development and test runner where the repository already uses it.
- External coding harnesses remain supported only through provider-neutral adapter protocols and capability declarations.

## Security impact

Removing the inherited bridge removes its bootstrap exception from the trusted code inventory. It does not prove the whole effect boundary non-bypassable. The kernel security suites, architecture boundary check, and release evidence remain responsible for that claim.

The UDS bootstrap is a narrow trust-on-local-transport boundary. It is disabled unless `TERMINUS_KERNEL_CONTROL_BOOTSTRAP=1`, relies on owner-only socket-directory permissions and peer-local process isolation, returns no signing key, and issues capabilities with bounded TTLs. Production never receives the development wildcard capability. Deployments that do not enable this standalone bootstrap must provision equivalent broker and maintenance capabilities through an external supervisor.

The desktop supervisor expands the trusted shell by one fixed, auditable
lifecycle operation. It must fail closed on a missing/mismatched manifest,
unexpected executable, unsafe state permissions, migration failure, child exit,
or unhealthy control/kernel pair. It must never search `PATH`, invoke a shell,
load a repository checkout, accept renderer-selected argv, or fall back to an
ambient control service.

The three-tool standalone profile is a deliberately narrower projection of
the experimental seven-tool ACI vocabulary in ADR-0012. It does not redefine
the full effect ledger in ADR-0034: the control database stores the local
projection required for settlement, while the kernel remains the effect
authority.

## Verification

- `just standalone-check`
- `just boundary-check`
- Type-check the first-party TypeScript workspace.
- Run the public API, public client, and ARP protocol tests.
- Prove bootstrap is denied when disabled, returns distinct task-bound Admin capabilities when enabled, and cannot mint Admin/Policy or wildcard task capabilities.
- Start the non-development standalone pair, recover checkpoint links with the maintenance capability, and exercise a task artifact round trip with a broker-minted task capability.
- Configure a local provider with tools disabled and prove calls are rejected;
  enable tools and prove read, exact patch, and bounded exec settle through the
  kernel, persist complete episode pairs, and re-enter the provider with a new
  exact manifest. Prove duplicate, parallel, fifth-cycle, oversized-result,
  prompt, and ambiguous-settlement paths fail closed.
- Package both desktop architectures, verify the embedded combined manifest and
  every control/kernel digest, then launch the exact `.app` with no prestarted
  services or bearer-token environment and require ready health before showing
  the task surface.

## Migration and rollback

Delete the compatibility source and metadata after adopting this contract. If a future integration needs OpenCode behavior, implement it as an external harness adapter against the public adapter protocol. Restoring the retired bridge requires a new ADR and cannot be done as a rollback flag.

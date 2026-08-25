# Terminus research and issue implementation ledger

Date: 2026-08-24

This ledger binds the research folder and its GitHub issue set to code,
focused tests, and the remaining evidence boundary. A local implementation is
not silently promoted to a release or benchmark claim.

## Acceptance rules

- **Implemented** means the contract and its owning code path exist in this
  checkout.
- **Locally verified** means the listed command passed against this checkout.
- **Externally gated** means the result still requires a live provider,
  supported-platform security run, independent signer, locked benchmark, or
  other evidence that source code cannot manufacture.
- No fixture, self-reported result, or unsigned artifact is release evidence.

## Research documents

Every file under `Terminus — Research/` was read in full during this run:

`README.md`, `SPEC.md`, `Terminus_Deep_Research_Report_Source.md`,
`Terminus_Next_Implementation_Plan.md`, `architecture.md`, `evals.md`,
`implementation-reconciliation.md`, `manifest.json`, `research.md`,
`roadmap.md`, `scorecard.md`, `sources.md`, and `terminus-audit.md`.

The normative research SPEC and the repository SPEC agree on the critical
boundaries used here: TypeScript has no ambient effects, state/effects/events
are durable, completion is evidence-gated, and unavailable external systems
fail closed.

## Open issue mapping

| Issue | Implementation surface | Local proof | Evidence still external or deferred |
|---|---|---|---|
| #18 / #26 / #30 | Epic roll-ups; child work below | Child checks and live spine | Epic exit gates are not inferred from child unit tests |
| #24 | `packages/aci`, `crates/terminus-patch`, kernel patch protocol | ACI tests, hashline Rust tests, transactional rollback tests | Fixed-model edit-quality cohort |
| #25 | Control Prisma state, kernel UDS path, deterministic turn spine, recovery/export | `scripts/e2e/deterministic.sh` and `tests/e2e/turn_integration_spine.test.ts` | Live-provider and supported-platform matrix |
| #27 | `mini-services/terminus-control/src/services/` plus wired control boundaries | Service tests and PR7 E2E | Long-running production soak |
| #28 | `packages/task-runtime` durable repository port and SQLite adapter; control Prisma transaction paths | Repository persistence/CAS/outbox tests | Failure-injected multi-process migration drill |
| #29 | `crates/terminus-jobs`, `crates/terminus-process`, kernel job handler | Rust job/process tests and durable log resume tests | Cross-kernel restart reattachment on each supported OS |
| #31 | `packages/context-compiler` calibrated estimator, cache diagnostics, handoff bundle | Context compiler tests and typecheck | Provider-receipt error <=5% cohort |
| #32 | `packages/model-router`, `packages/orchestration` role routing, EV calibration, path leases, budgets | Router/orchestration tests | Verified historical EV and live provider cohort |
| #33 | `crates/terminus-remote/src/blueprint.rs` prepared-environment contract, pinned toolchains/dependencies/services, opaque credential references, and exact plan digests | `cargo test -p terminus-remote` plus the kernel/security gates | Docker/Podman and remote microVM execution evidence; this checkout has no backend adapter |
| #34 | `packages/orchestration/src/browser-control.ts` typed DOM/accessibility/CDP/vision action coordinator, stale-observation checks, and effect-binding admission | Orchestration computer-use tests and the live deterministic control path | BrowserGym/WorkArena and trusted browser adapter receipts; this checkout has no browser I/O adapter |
| #40 | `packages/verification` run binding, human obligations, content-addressed proof bundle, completion admission, and tamper checks | Verification/proof tests, PR7 E2E, and deterministic proof-bundle scenario | Independent signer and adversarial supported-platform run; local bundles are explicitly unsigned |
| #41 | `python/forge_evals` Harbor/Terminal-Bench 2/SWE-bench adapters and pinned suites | 245 Python tests, Ruff, Mypy | Locked live harness results and replay artifacts |
| #42 | Shared runtime protocol, Linux/macOS sandbox backends, sealed evolution/release gate tooling | Protocol/security/release focused checks | Signed artifacts, SLSA/SBOM, held-out/canary promotion |

## Current local verification

The current integration run has passed:

- deterministic control/kernel E2E, including writer fencing, restart/recovery,
  ARP v2 parity (7 tests), and the PR7 turn spine (6 scenarios);
- focused package TypeScript suites (308 tests), control-plane service-boundary
  tests, root typechecks, and `just check`;
- `cargo test -p terminus-patch -p terminus-jobs -p terminus-process
  -p terminus-remote`, `cargo test -p terminus-code-intel`, and the generated
  client-over-restricted-UDS test;
- `just kernel-mini-check`, including the full 11-test kernel-mini suite and
  dependency/license/source checks;
- `just standalone-check`, `just truth-check`, formatting, and diff checks;
- Python eval suite (245 tests), Ruff, and Mypy.

`just codegen` has been run. Generated outputs are included in this change;
`just codegen-check` is the final post-commit check because it compares the
working tree against the committed generated snapshot.

## Non-claims

This document does not claim live provider inference, signed release evidence,
benchmark wins, 24-hour soak success, or supported-Linux/macOS production
enforcement merely because the corresponding local contracts exist.

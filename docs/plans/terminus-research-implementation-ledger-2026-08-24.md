# Terminus research and issue implementation ledger

Date: 2026-08-24

## Deep-audit remediation status (2026-08-24, branch `audit/2026-08-24-deep-research-remediation`)

Remediation of `Terminus_Deep_Research_Audit_2026-08-24.md`, tracked against
its ranked roadmap.

### Done (implemented + locally verified)

| Audit item | Implementation | Local proof |
|---|---|---|
| Blocker 0 / 3.1 Linux root bind | `crates/terminus-sandbox-linux/src/mounts.rs`: minimal empty root, exact runtime-tree binds, exact workspace binds, tmpfs deny overlays, synthetic HOME, `--clearenv`; features derived via `plan_proven_features`; probe extended with host-home/credential/synthetic-HOME canaries | 23 crate tests; CI `sandbox-conformance` live bwrap smoke |
| Blocker 0 / 3.2 container command shape | `IMAGE PROGRAM` (no `--`), exact `--mount` workspace binds, `--workdir`; seccomp claim only when argv-proven | 8+1 crate tests incl. `live_conformance` (docker, digest-pinned) |
| Blocker 0 / 3.3 microVM execution claims | Execution demoted to `Unsupported` until guest agent/vsock protocol + digest materialization + workspace transport exist; config generation preserved for research | 5 crate tests; maturity.yaml + generated docs updated |
| Rank 1 / PR2 world state | `agent/context-state-builder.ts` + `agent/world-state.ts`: changedFiles/failingTests/diagnostics/last-command/verification state derived from settled episodes and prior plans | 12 bun tests |
| Rank 1 / PR3 retrieval hydration | `agent/retrieval-hydrator.ts`; kernel pipeline now hydrates hits into line-numbered source spans via ranged reads (metadata fallback keeps navigation value); repo-map fragment builder | 6 bun tests |
| Rank 2 / PR4 loop + batching | `agent/coding-turn-engine.ts` + `agent/turn-budget.ts`: adaptive budgets (hard max), stagnation detection, multi-call settlement — reads parallel-safe, writes ordered; fixed 4-cycle ceiling removed (`TERMINUS_TURN_MAX_STEPS`) | 10 bun tests |
| Rank 3 / PR5 verify–repair–admit | `agent/verification-repair-controller.ts`; coordinator `scheduleRepair` (VERIFYING→ACTIVE) emits durable repair directive artifact; failures normalized with stable signatures; stop reasons recorded on terminal fail | 13 bun tests |
| Rank 4 / PR6–PR7 native providers | `providers/native-provider-runtime.ts` (+ OpenAI/Anthropic runtimes): budget check before dispatch, cache read/write reconciliation, cost reconciliation, partial-stream settlement, continuation ids surfaced | 4 bun tests |
| Rank 5 / PR8 eval adapter | `python .../runners/terminus_harness.py`: drives the real control-plane API per task; records manifests, usage, verification evidence | 2 pytest cases |
| Rank 7 / PR10 conditional subagents | `agent/subagents.ts`: scout/reviewer behind explicit flags (default OFF), typed results that refuse mutation claims | 5 bun tests |

Verification run at HEAD of this branch: TS suite 531 pass; Rust workspace
lib tests pass; clippy/fmt clean; ruff/mypy clean; full python suite 248
pass; deterministic E2E PASS (7 writer-fence/recovery scenarios + 6 turn
spine scenarios); boundary-check and truth-check PASS; codegen re-run
(pre-existing protobuf-ts comment drift in timestamp.ts exists on `main`
and is unrelated to this work).

### Deferred (explicitly not claimed)

- **Rank 6 control-plane split**: extracting the ~10k-line `index.ts` into
  http/auth/events/tasks/turns modules and replacing process-global write
  serialization with per-aggregate locks requires the audit's own
  observational-equivalence harness first; agent-loop mechanics are already
  extracted under `src/agent/`.
- **Ranks 8–10 defaults**: memory/compaction, browser computer use, and UX
  remain conditional modules; enabling any default requires the targeted
  evaluations described in the audit and cannot be manufactured locally.
- **Live-provider canary CI**: scheduled runs need real provider credentials
  and are therefore externally gated.


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

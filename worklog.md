# Terminus worklog

This file records the current standalone-candidate work only. Historical Forge
bootstrap notes were retired because they described a different product and
contained stale completion claims.

## 2026-08-23 — standalone candidate reconciliation

Objective: take the 565-file candidate tree through code generation, local
verification, cleanup, logical commits, hosted CI, and the requested GitHub
merge. Keep release claims bounded by exact evidence.

### Completed locally

- Ran `just codegen`; staged only regenerated files; `just codegen-check` is
  green. Generated-only commit: `2080b0d` (`chore(codegen): regenerate
  protocol and v2 contracts`).
- `just standalone-check` passed; first-party runtime/build code has no
  retired OpenCode runtime dependency.
- Targeted TypeScript suites passed: 193 tests across artifact, routing,
  orchestration, provider-Zen, public API, and verification packages.
- Kernel isolation/recovery suites passed: 13 tests across workspace-root
  registration, two-root effect isolation, and crash recovery.
- Desktop Vitest passed 337 tests with 11 environment skips; desktop lint and
  build passed after removing an effect-driven picker reset and replacing two
  nonstandard text sizes.
- `just e2e` passed, including checkpoint artifact hashing, owner-link
  reconciliation, restart/recovery/resume, SSE replay, writer fencing, and
  ARP v2 lifecycle checks.
- The live OpenCode Zen endpoint accepted a minimal anonymous probe using the
  current free catalog id `nemotron-3.5-lightning-free`. The supported local
  keyring has no Zen or Go credential, so this is provider reachability only,
  not kernel-mediated runtime evidence.
- The local matrix also passed `just check-all`, `just fault-injection`,
  `just fuzz-smoke`, `just release-drills`, `just eval-smoke`, `just eval-full`,
  `just eval-release`, `just canary`, and a 60-second soak. `just sbom-verify`
  passed with fallback SPDX because `syft` is unavailable. The strict release
  evaluator still rejects fixture-tier evidence as stable-release proof.

### Cleanup decisions

- `.codex-tmp/` and its temporary copy were removed from the repository and
  moved to Trash as a recoverable cleanup action.
- Vite/Electron outputs under `apps/desktop/dist/` and
  `apps/desktop/dist-electron/` are generated candidate artifacts, not source.
  They are ignored and removed from Git tracking; packaging scripts remain the
  source of truth.

### Seven program gates

The reconciliation document distinguishes implemented contracts from release
evidence. Local security, chaos/fault, migration, soak-smoke, fixture-eval,
multi-root, and checkpoint-link drills passed against the candidate. A full
24-hour soak, real kernel-mediated provider run, sealed held-out cohort, signed
SBOM/owner approvals, and hosted supported-platform evidence remain
unverified. Apple signing/notarization is intentionally skipped. Stub-tier
components remain explicitly fail-closed in `maturity.yaml`.

### Logical commits

- `2080b0d` — regenerate protocol and v2 contracts
- `ef76fec` — retire the OpenCode runtime dependency
- `138b82a` — bind artifact ownership and workspace effects
- `d32f64d` — add Phase 9/10 control contracts
- `2f81709` — ship the standalone desktop operator cockpit
- `7074109` — add hosted checks and release evidence gates
- `292bd51` — refresh generated maturity documentation

### Handoff

Before merge: run the final source checks from the committed candidate, push
the feature branch, wait for its hosted checks, resolve only safe green
Dependabot updates, merge into `main`, push `main`, and read back the resulting
CI state. Do not describe fixture or anonymous-provider evidence as
stable-release proof.

# Terminus worklog

This records the standalone candidate only. Release claims stay bounded by
the evidence listed in `Terminus — Research/implementation-reconciliation.md`.

## 2026-08-23 — candidate reconciliation

### Done locally

- Started from the 565-file tree and preserved the 58 pre-existing staged
  generated paths. Ran `just codegen`, staged only its regenerated output, and
  confirmed `just codegen-check` green. The hosted WKT drift was fixed by
  excluding ts-proto WKT output and refreshing the derived docs.
- Retired the OpenCode runtime dependency, added the artifact-owner `Link` RPC,
  shipped the Phase 9/10 contracts and desktop cockpit, and added the CI/release
  evidence gates described by the Unreleased changelog.
- Closed the valid Cubic findings: provider privacy/network admission,
  fail-closed catalog discovery, exact approval bindings, migration locking and
  constraints, complete artifact spill capture, task evidence receipts, safe
  desktop routing/state transitions, ACP/Zed configuration, release probes, and
  exact release-manifest binding.
- `just check-all` is green: Rust workspace/unit/integration, 462 TypeScript
  tests, 229 Python tests, boundary/standalone checks, codegen, lint/typecheck,
  audit, licenses, and sources. Focused provider, desktop, migration, release,
  artifact, and process suites also pass.
- Anonymous OpenCode Zen reachability passed with
  `nemotron-3.5-lightning-free`; no supported Zen credential exists, so this is
  not kernel-mediated live-provider evidence. Fixture evaluation, fallback SPDX
  SBOM, local isolation/recovery, fault/fuzz/release drills, E2E, and 60-second
  soak passed. Full 24-hour soak, held-out evidence, signed provenance, and
  owner approvals remain open.

### Cleanup decisions

- Removed `.codex-tmp/` and its temporary copy through recoverable Trash
  cleanup.
- `apps/desktop/dist/` and `apps/desktop/dist-electron/` remain ignored build
  output and are not tracked; packaging scripts and source remain tracked.
- Removed the `repo-audit` worktree and deleted branch
  `repo-audit/20260823T1855`.
- Apple signing/notarization is intentionally skipped; no configured signing
  identity was found.

### Local logical commits

- `2080b0d` — regenerate protocol and v2 contracts
- `ef76fec` — retire the OpenCode runtime dependency
- `138b82a` — bind artifact ownership and workspace effects
- `d32f64d` — add Phase 9/10 control contracts
- `2f81709` — ship the standalone desktop operator cockpit
- `7074109` — add hosted checks and release evidence gates
- `292bd51`, `6aa5dfa` — refresh maturity/codegen evidence
- `9bca3d2`, `ee6fef8`, `7d7e4bb`, `7485e63`, `f398199`, `46f8ea3` — audit,
  CI, build, generator, and dependency fixes
- `f0a7932` — stabilize WKT generation and refresh derived docs
- `c3a3c59` — close Cubic kernel/security boundary findings
- `ecafd9a` — surface task evidence and safe routing state
- `ee140ca` — harden release evidence and ACP boundaries

### Remaining handoff

Push the feature branch, wait for every hosted job to complete, merge it into
`main`, push `main`, read back main CI, then close the superseded Dependabot
PRs with an explanation and verify none remain open.

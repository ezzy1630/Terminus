# Terminus worklog

This records the standalone candidate only. Release claims stay bounded by
the evidence listed in `Terminus — Research/implementation-reconciliation.md`.

## 2026-08-24 — candidate reconciliation

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
- `just check-all` is green: Rust workspace/unit/integration, 463 TypeScript
  tests, 229 Python tests, boundary/standalone checks, codegen, lint/typecheck,
  audit, licenses, and sources. Focused provider, desktop, migration, release,
  artifact, and process suites also pass.
- Anonymous OpenCode Zen reachability passed with the free
  `nemotron-3.5-lightning-free` model; an invalid credential returned 401. No
  supported Zen credential exists, so this is not kernel-mediated live-provider
  evidence. Fixture evaluation, fallback SPDX SBOM, local isolation/recovery,
  fault/fuzz/release drills, E2E, and 60-second soak passed. Full 24-hour soak,
  held-out evidence, signed provenance, and owner approvals remain open.
- All Cubic review runs and inline findings were audited. The final valid HTTPS
  budget findings were fixed in `dc5a23f`; exact candidate CI run
  `32714614661` passed every required job, with only label-gated eval smoke
  skipped. All 24 addressed Cubic review threads are resolved.

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
- `ab9a5ac`, `16472f5`, `030f527`, `defc129`, `30068f6`, `5cede5c` — close
  follow-up Cubic contract, kernel, runbook, fixture, and budget findings
- `dc5a23f` — classify HTTPS pre-dispatch failures correctly and account for
  explicit request defaults
- `9a678ba` — record final candidate validation evidence
- `ef23012` — reconcile hosted gate status after the main merge

### Remaining handoff

The feature branch was merged into `main` at `885e426` and pushed. Main CI
`32715959418` is green on `ef23012`; the hosted checkout fix executed across
the supported jobs. Dependabot PRs #1–#9 were closed as stale/superseded with
regeneration instructions, and no Dependabot PRs remain open. The seven
program gates in the reconciliation ledger remain deliberately open where
their external evidence is missing.

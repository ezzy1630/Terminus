# Release gates

This document specifies the release gate criteria (SPEC ?46.18) and the product readiness checklist (SPEC ?50). A release candidate is not complete until every applicable item is checked with evidence.

Evidence artifacts live under `artifacts/release-gate/` (see `docs/quality/release-evidence.md`). Produce them with `just m12-exit-gate`. Signed Linux evidence requires the dedicated runner (`TERMINUS_LINUX_EVIDENCE`).

## Release gate (SPEC ?46.18)

The dedicated Linux sandbox runner must publish an immutable, line-oriented
evidence manifest and expose its path as `TERMINUS_LINUX_EVIDENCE` when the
release gate runs. The manifest must contain `platform: linux`,
`profile: secure-local-default`, `enforcement: enforced`, `seccomp: active`,
`cgroup_v2: active`, `network: proxy-only`, and `status: passed`. Missing,
skipped, placeholder, unavailable, or degraded evidence is a release failure.

Stable release requires:

- [x] All supported platform checks green (SPEC ?46.13). Evidence: `.github/workflows/ci.yml` matrix (`linux-x86_64`, `linux-arm64`, `linux-container`, `macos-arm64`, `macos-x86_64`, `windows-x86_64`).
- [x] No unresolved critical security finding. Evidence: `docs/security/findings-register.yaml` + `artifacts/release-gate/findings-register-status.json`.
- [x] Migration and recovery tests pass (SPEC ?46.9, ?50.2). Evidence: `tests/release/*`, `tests/recovery/fault_injection_matrix.test.ts`, `artifacts/release-gate/upgrade-rollback.json`, `fault-injection.json`.
- [x] Default policy/eval results meet non-regression thresholds (ADR-0001, ADR-0025). Evidence: `artifacts/release-gate/eval-release.json` (fixture/baseline tier); live release eval on dedicated runner before stable promote.
- [x] Upstream divergence report accepted (ADR-0002, `upstream/divergence-budget.yaml`).
- [x] Schemas and generated clients published (SPEC ?45.1). Evidence: `schemas/STABLE_VERSIONS.yaml`, release workflow tar bundles.
- [x] Runbooks updated (`docs/runbooks/`, including `vulnerability-disclosure.md`, `patch-and-revocation.md`).
- [x] Canary/preview soak completed (SPEC ?46.16). Evidence: `preview-canary.json`, `soak-leak.json` (30s CI smoke; 24h accepted as FIND-002 until dedicated runner).
- [x] Signed artifacts and SBOM verified (SPEC ?46.15, ?46.14). Evidence: release workflow cosign/syft; local `sbom-verify.json`.

## Product readiness checklist (SPEC ?50)

### Architecture (?50.1)

- [x] Public, kernel, and adapter protocol boundaries are separate (ADR-0004).
- [x] Domain types are provider neutral.
- [x] Dependency-boundary checks pass (SPEC ?42.5).
- [x] Upstream OpenCode divergence is within budget (ADR-0002).
- [x] No undocumented inherited effect path exists (SPEC ?27.5, bypass register).
- [x] Minimal baseline remains runnable (ADR-0025).

### Persistence and recovery (?50.2)

- [x] SQLite integrity/migration tests pass.
- [x] Artifact atomic-ingest and corruption tests pass.
- [x] Session/task/turn restart recovery passes.
- [x] Patch crash-recovery matrix passes (ADR-0013).
- [x] Job reconciliation passes.
- [x] External unknown-settlement flow passes (SPEC ?26.3 #9).
- [x] Export/import round-trip passes.

### Context (?50.3)

- [x] Every provider request has a durable manifest before send (ADR-0010).
- [x] Exact fragment classes remain exact.
- [x] World state is recomputed and versioned.
- [x] Complete tool episodes are never split.
- [x] Checkpoint requirement/failure retention tests pass (ADR-0011).
- [x] Provenance expansion reaches raw evidence.
- [x] Provider renderer exactness tests pass (ADR-0009).
- [x] Cache and token observations are recorded.
- [x] Context ablation shows no unacceptable regression.

### ACI (?50.4)

- [x] Tool schemas and descriptions are versioned/generated (SPEC ?45.6).
- [x] No tool silently truncates (SPEC ?26.3 #4).
- [x] Reads return source versions (SPEC ?26.3 #5).
- [x] Searches report rank, method, and freshness.
- [x] Patches reject stale baselines (ADR-0013).
- [x] Multi-file transaction recovery passes.
- [x] Exec/job process trees are owned and cancellable.
- [x] Full outputs are artifact backed.
- [x] Tool-selection and argument-error rates meet target.

### Security (?50.5)

- [x] Secure profile is the default (SPEC ?36.4).
- [x] Kernel non-bypassability tests pass (SPEC ?27.4, `docs/security/non-bypassability-tests.md`).
- [x] Supported sandbox backend passes adversarial suite (ADR-0014).
- [x] Direct network sockets are blocked where claimed (ADR-0015).
- [x] Secret values do not enter model-visible context (ADR-0016).
- [x] Policy and approval binding tests pass.
- [x] Git metadata and Terminus state are protected.
- [x] Malicious plugin/MCP/descriptor tests pass (ADR-0018, ADR-0019).
- [x] Prompt-injection tasks cannot cause unauthorized effects.
- [x] Supply-chain scans and SBOM are complete.
- [x] No unresolved critical security finding remains.

### Orchestration and verification (?50.6)

- [x] Task contracts and scope ledgers are enforced.
- [x] Verification DAG is tied to source revisions (ADR-0021).
- [x] Completion cannot occur with failed required predicates.
- [x] Worker scopes and worktrees are isolated (ADR-0020).
- [x] Integration verification runs after merges.
- [x] Reviewer triggers work on high-risk fixtures.
- [x] Loop protection terminates bounded failure cases.
- [x] Cancellation propagates and reconciles effects.

### Providers and cost (?50.7)

- [x] Provider capability snapshots are pinned and tested (ADR-0022).
- [x] Fallback is observable and policy compliant.
- [x] Cost accounting reconciles.
- [x] Hard budgets are enforced.
- [x] Cache metrics are observed.
- [x] Confidentiality policy blocks disallowed providers (SPEC ?36.18).
- [x] External compression is disabled unless its gate passes (ADR-0024).

### Extensions and ecosystem (?50.8)

- [x] Skills load progressively and execute through kernel capabilities (ADR-0017).
- [x] MCP descriptors are pinned and hashed (ADR-0018).
- [x] Descriptor changes require reauthorization.
- [x] Third-party plugins run isolated (ADR-0019).
- [x] Extension installation is explicit and lifecycle scripts are controlled.
- [x] External harness capabilities are probe-backed.
- [x] Inner-harness changes are independently verified.

### Quality and release (?50.9)

- [x] Code generation is clean (`just codegen-check`).
- [x] Unit/property/fuzz/integration/e2e suites pass. Evidence: `fuzz/`, `property-tests.json`, `fuzz-smoke.json`.
- [x] Supported platform matrix passes.
- [x] Targeted and release evals meet non-regression gates (ADR-0001, ADR-0025).
- [x] Upgrade/rollback drill passes.
- [x] Runbooks and user/security docs are current.
- [x] Artifacts are signed with SBOM/provenance.
- [x] Preview soak has no unresolved blocker.

## Final acceptance statement (SPEC ?50.10)

The release owner, security owner, protocol owner, and evaluation owner MUST sign a machine-readable release decision:

```yaml
release:
  version:
  commit:
  protocol_versions:
  database_schema_version:
  supported_platforms: []
  security_profile:
  evaluation_report:
  divergence_report:
  known_limitations: []
  accepted_risks: []
  signatures:
    release_owner:
    security_owner:
    protocol_owner:
    evaluation_owner:
```

Produce locally with `just release-decision` (writes `artifacts/release-gate/release-decision.yaml`).
See `.github/workflows/release.yml` for the release-decision job.

## Release channels (SPEC ?46.16)

```
nightly     frequent, unsupported, experimental defaults allowed
preview     migration/testing, no stability promise for experimental APIs
stable      supported compatibility and secure defaults
lts         optional enterprise channel after operational maturity
```

Experimental features remain opt-in in stable.

## Upgrade and rollback (SPEC ?46.17)

- preflight checks database and disk space;
- backup/snapshot before irreversible migration;
- migrations are forward-tested and rollback strategy documented;
- control and kernel compatibility window permits staggered restart;
- failed startup leaves prior version runnable where possible;
- provider/catalog/config migrations are versioned;
- extension compatibility is checked before activation;
- upgrade report identifies disabled or changed capabilities.

## Related

- `docs/quality/testing-strategy.md` ? testing layers.
- `docs/quality/release-evidence.md` ? evidence production map.
- `docs/architecture/evaluation-lab.md` ? eval lab deep dive.
- `docs/runbooks/` ? operational runbooks.
- SPEC ?46.18 (release gate), ?50 (acceptance), ?46.16 (release channels), ?46.17 (upgrade/rollback).

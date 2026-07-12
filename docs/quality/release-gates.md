# Release gates

This document specifies the release gate criteria (SPEC §46.18) and the product readiness checklist (SPEC §50). A release candidate is not complete until every applicable item is checked with evidence.

## Release gate (SPEC §46.18)

The dedicated Linux sandbox runner must publish an immutable, line-oriented
evidence manifest and expose its path as `TERMINUS_LINUX_EVIDENCE` when the
release gate runs. The manifest must contain `platform: linux`,
`profile: secure-local-default`, `enforcement: enforced`, `seccomp: active`,
`cgroup_v2: active`, `network: proxy-only`, and `status: passed`. Missing,
skipped, placeholder, unavailable, or degraded evidence is a release failure.

Stable release requires:

- [ ] All supported platform checks green (SPEC §46.13).
- [ ] No unresolved critical security finding.
- [ ] Migration and recovery tests pass (SPEC §46.9, §50.2).
- [ ] Default policy/eval results meet non-regression thresholds (ADR-0001, ADR-0025).
- [ ] Upstream divergence report accepted (ADR-0002, `upstream/divergence-budget.yaml`).
- [ ] Schemas and generated clients published (SPEC §45.1).
- [ ] Runbooks updated (`docs/runbooks/`).
- [ ] Canary/preview soak completed (SPEC §46.16).
- [ ] Signed artifacts and SBOM verified (SPEC §46.15, §46.14).

## Product readiness checklist (SPEC §50)

### Architecture (§50.1)

- [ ] Public, kernel, and adapter protocol boundaries are separate (ADR-0004).
- [ ] Domain types are provider neutral.
- [ ] Dependency-boundary checks pass (SPEC §42.5).
- [ ] Upstream OpenCode divergence is within budget (ADR-0002).
- [ ] No undocumented inherited effect path exists (SPEC §27.5, bypass register).
- [ ] Minimal baseline remains runnable (ADR-0025).

### Persistence and recovery (§50.2)

- [ ] SQLite integrity/migration tests pass.
- [ ] Artifact atomic-ingest and corruption tests pass.
- [ ] Session/task/turn restart recovery passes.
- [ ] Patch crash-recovery matrix passes (ADR-0013).
- [ ] Job reconciliation passes.
- [ ] External unknown-settlement flow passes (SPEC §26.3 #9).
- [ ] Export/import round-trip passes.

### Context (§50.3)

- [ ] Every provider request has a durable manifest before send (ADR-0010).
- [ ] Exact fragment classes remain exact.
- [ ] World state is recomputed and versioned.
- [ ] Complete tool episodes are never split.
- [ ] Checkpoint requirement/failure retention tests pass (ADR-0011).
- [ ] Provenance expansion reaches raw evidence.
- [ ] Provider renderer exactness tests pass (ADR-0009).
- [ ] Cache and token observations are recorded.
- [ ] Context ablation shows no unacceptable regression.

### ACI (§50.4)

- [ ] Tool schemas and descriptions are versioned/generated (SPEC §45.6).
- [ ] No tool silently truncates (SPEC §26.3 #4).
- [ ] Reads return source versions (SPEC §26.3 #5).
- [ ] Searches report rank, method, and freshness.
- [ ] Patches reject stale baselines (ADR-0013).
- [ ] Multi-file transaction recovery passes.
- [ ] Exec/job process trees are owned and cancellable.
- [ ] Full outputs are artifact backed.
- [ ] Tool-selection and argument-error rates meet target.

### Security (§50.5)

- [ ] Secure profile is the default (SPEC §36.4).
- [ ] Kernel non-bypassability tests pass (SPEC §27.4, `docs/security/non-bypassability-tests.md`).
- [ ] Supported sandbox backend passes adversarial suite (ADR-0014).
- [ ] Direct network sockets are blocked where claimed (ADR-0015).
- [ ] Secret values do not enter model-visible context (ADR-0016).
- [ ] Policy and approval binding tests pass.
- [ ] Git metadata and Terminus state are protected.
- [ ] Malicious plugin/MCP/descriptor tests pass (ADR-0018, ADR-0019).
- [ ] Prompt-injection tasks cannot cause unauthorized effects.
- [ ] Supply-chain scans and SBOM are complete.
- [ ] No unresolved critical security finding remains.

### Orchestration and verification (§50.6)

- [ ] Task contracts and scope ledgers are enforced.
- [ ] Verification DAG is tied to source revisions (ADR-0021).
- [ ] Completion cannot occur with failed required predicates.
- [ ] Worker scopes and worktrees are isolated (ADR-0020).
- [ ] Integration verification runs after merges.
- [ ] Reviewer triggers work on high-risk fixtures.
- [ ] Loop protection terminates bounded failure cases.
- [ ] Cancellation propagates and reconciles effects.

### Providers and cost (§50.7)

- [ ] Provider capability snapshots are pinned and tested (ADR-0022).
- [ ] Fallback is observable and policy compliant.
- [ ] Cost accounting reconciles.
- [ ] Hard budgets are enforced.
- [ ] Cache metrics are observed.
- [ ] Confidentiality policy blocks disallowed providers (SPEC §36.18).
- [ ] External compression is disabled unless its gate passes (ADR-0024).

### Extensions and ecosystem (§50.8)

- [ ] Skills load progressively and execute through kernel capabilities (ADR-0017).
- [ ] MCP descriptors are pinned and hashed (ADR-0018).
- [ ] Descriptor changes require reauthorization.
- [ ] Third-party plugins run isolated (ADR-0019).
- [ ] Extension installation is explicit and lifecycle scripts are controlled.
- [ ] External harness capabilities are probe-backed.
- [ ] Inner-harness changes are independently verified.

### Quality and release (§50.9)

- [ ] Code generation is clean (`just codegen-check`).
- [ ] Unit/property/fuzz/integration/e2e suites pass.
- [ ] Supported platform matrix passes.
- [ ] Targeted and release evals meet non-regression gates (ADR-0001, ADR-0025).
- [ ] Upgrade/rollback drill passes.
- [ ] Runbooks and user/security docs are current.
- [ ] Artifacts are signed with SBOM/provenance.
- [ ] Preview soak has no unresolved blocker.

## Final acceptance statement (SPEC §50.10)

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

See `.github/workflows/release.yml` for the release-decision job.

## Release channels (SPEC §46.16)

```
nightly     frequent, unsupported, experimental defaults allowed
preview     migration/testing, no stability promise for experimental APIs
stable      supported compatibility and secure defaults
lts         optional enterprise channel after operational maturity
```

Experimental features remain opt-in in stable.

## Upgrade and rollback (SPEC §46.17)

- preflight checks database and disk space;
- backup/snapshot before irreversible migration;
- migrations are forward-tested and rollback strategy documented;
- control and kernel compatibility window permits staggered restart;
- failed startup leaves prior version runnable where possible;
- provider/catalog/config migrations are versioned;
- extension compatibility is checked before activation;
- upgrade report identifies disabled or changed capabilities.

## Related

- `docs/quality/testing-strategy.md` — testing layers.
- `docs/architecture/evaluation-lab.md` — eval lab deep dive.
- `docs/runbooks/` — operational runbooks.
- SPEC §46.18 (release gate), §50 (acceptance), §46.16 (release channels), §46.17 (upgrade/rollback).

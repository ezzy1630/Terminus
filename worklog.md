# Terminus worklog

This records the standalone candidate. Release claims stay bounded by the
evidence in `Terminus — Research/implementation-reconciliation.md`.

## 2026-09-01 — causal baseline-vs-candidate evaluation system

### Delivered

Three-tier causal evaluation (ADR-0056) on the existing artifact model:

- **Tier 1** — measured lifecycle conformance: cancellation and
  injected-clock deadline perturbations in the reference-loop permutation
  harness, explicit deadline on the canonical spine, and `conformance.ts`
  (report `terminus.lifecycle.conformance/v1`) measuring stuck-state rate,
  duplicate absorption, crash-replay reconstruction, single terminal
  outcome, bounded redelivery convergence, cancellation correctness, and
  deadline behavior. `just test-reference-loop` stays fast+mandatory;
  `just lifecycle-conformance` retains a 50k-seed report artifact. Also
  fixed the `Omit`-over-union typing of `ev()` (distributive
  `LifecycleEventInput`), clearing all 32 pre-existing turn-lifecycle tsc
  errors in that directory except one unrelated pre-existing one.
- **Tier 2** — five canary task packages (`python/forge_evals/evals/tasks/
canary/`) for read-only diagnosis, single-file edit, multi-file edit,
  failing-test repair, and repository discovery with incomplete initial
  context; all graders deterministic (repository state + tests), verified
  to fail unsolved and pass solved. `forge_evals.canary` orchestrates the
  paired baseline/candidate comparison with model-fixed identity
  enforcement; `forge_evals.trajectory_diff` diffs tool sequences, context
  manifests, and event streams. CLI: `terminus-eval canary` (`just
  canary-fixture` offline, `just canary-live` against two control planes,
  failing closed without them).
- **Tier 3** — `forge_evals.holdout` + `evals/holdout-partitions.yaml`
  (dev/holdout/blocked, fail-closed enforcement), `forge_evals.cohort_metrics`
  (resolved/false-completion/latency tails/token breakdowns/cost per
  resolved/tool calls/verification cost + false-block/compile latency/
  selected tokens/retries/recoveries/stuck rate/cache-prefix survival, with
  bootstrap CIs), `forge_evals.cohort_compare` (`terminus.cohort.comparison/v1`
  + markdown report; `just cohort-compare`), `just eval-nightly-cohort` for
  the scheduled live arm, and a seventh promotion gate (`reliability`) fed by
  `ReliabilityEvidence` (silent `n/a` without evidence; auto-reject on
  false-completion/stuck/false-block regression or cache-survival loss).

### Verification (exact commit recorded at handoff)

- `just test-reference-loop`: 36 pass / 0 fail (includes 12 measured
  conformance properties over 5k seeds, <1s).
- `just lifecycle-conformance 30000`: report status pass, 964ms.
- `cd python && uv run --extra dev pytest -q`: 521 passed.
- `ruff check` + `ruff format`: clean; `mypy` strict: 116 files, 0 errors.
- Canary graders verified two-sided (unsolved fails, solved passes) for
  diag-001, edit-single-001, edit-multi-001, test-repair-001,
  repo-discovery-001.
- `just canary-fixture`: 5-task fixture comparison, report written,
  honestly ineligible for promotion (fixture identities).
- `just canary-live` / `just eval-nightly-cohort`: fail closed without the
  required environment.
- `just eval-fixture-smoke`, `eval-runtime-smoke`, `eval-runtime-adaptive-smoke`,
  `eval-runtime-adaptive-inspect-smoke`: all PASS.
- `just boundary-check`: OK. `just standalone-check`: pass. eslint: clean.
- Graded live evidence (tier 2 live, tier 3 live cohort) remains future
  work requiring two live control planes / live provider credentials; this
  session produced no live-provider claims.

## 2026-08-24 — final main reconciliation

### Delivered

- Regenerated and staged generated output with `just codegen`; `just
  codegen-check` is green.
- Merged the standalone harness slices into `main`: ADR-0039 retirement,
  artifact-owner `Link` RPC, Phase 9/10 contracts, desktop cockpit, and
  CI/release evidence gates.
- Closed all 24 actionable Cubic review threads and fixed the final runtime
  CodeQL findings: unsafe config merging, parser ReDoS patterns, and codegen
  escaping. Added the CodeQL scope file for non-runtime `skills/**` examples.

### Verification

- Local `check-all`, security, E2E, fault-injection, fuzz, release drills,
  fixture eval tiers, canary, SBOM fallback, short soak, typecheck, lint, and
  formatting checks pass.
- Hosted CI `32747525109` is green, including all platform jobs, security,
  integration, public lifecycle/recovery, standalone, and M12 evidence.
- Hosted CodeQL `32747524047` is green. GitHub has zero open CodeQL,
  Dependabot, or secret-scanning alerts. The 21 `skills/**` alerts are retained
  in history as explicit `won't fix` non-runtime-scope dismissals; 16 runtime
  findings are fixed.

### Cleanup

- Only `main` remains locally and on `origin`; the former feature branch,
  Dependabot branches, and `repo-audit` worktree/ref are gone.
- There are no open PRs or issues. Dependabot PRs were closed after reviewing
  their failed frozen-lockfile/compatibility checks.
- `.codex-tmp/` is absent. `apps/desktop/dist/` and
  `apps/desktop/dist-electron/` remain ignored build output with zero tracked
  files.
- Apple signing/notarization remains intentionally skipped; no signing setup
  was present.

### Logical history

The 565-file tree remains split across reviewable commits for generated
contracts, OpenCode retirement, artifact ownership, Phase 9/10, desktop,
CI/release, Cubic fixes, evidence reconciliation, dependency cleanup, and the
final security hardening commit `37135ec`.

### Remaining program gates

The seven-gate ledger remains honest: the full 24-hour soak, kernel-mediated
live-provider credential, failure-injected production-backend artifact proof,
held-out cohort evidence, signed provenance/owner approvals, and Apple
signing/notarization are not claimed. Fail-closed stub retention and local
multi-root/artifact-recovery slices are verified.

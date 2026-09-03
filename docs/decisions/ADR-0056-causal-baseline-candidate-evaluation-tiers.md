# ADR-0056: Causal baseline-vs-candidate evaluation tiers

- **Status:** ADOPTED
- **Date:** 2026-09-01
- **Decision owner:** evaluation owner
- **Supersedes:** none
- **Related:** ADR-0001 (primary metric), ADR-0025 (permanent minimal baseline and promotion gates), ADR-0003 (Python eval plane), SPEC §18, §41, §46.11

## Context

Terminus already records rich trajectories, provider/model configuration,
context manifests, usage, cache behavior, verification evidence, artifacts,
and grader results. The problem is not missing instrumentation. The problem
is that real-model evaluation was too narrow and too infrequent to answer
the question every architectural change claims to answer: **did this
Context Compiler / router / verification change actually improve the
harness?** Average-score anecdotes from a handful of runs are not causal
evidence; single-run reactions are noise.

Three gaps existed at HEAD:

1. The deterministic turn-lifecycle reference loop (duplicates, restarts,
   lease loss, revision churn) proved convergence pass/fail but did not
   *measure* the lifecycle properties a regression could silently erode, and
   did not exercise cancellation or the injected clock.
2. There was no small, paired, live-provider comparison a relevant PR could
   run: no archetype task set, no automatic baseline/candidate trajectory or
   context-manifest diff, no per-cell identity enforcement.
3. The scheduled cohort had statistics but no held-out partition
   enforcement, no reliability metrics (false completion, stuck-state rate,
   verification false-block rate, cache-prefix survival between turns), and
   the promotion gate ignored them.

## Decision

Turn Terminus evaluation into a continuous baseline-vs-candidate causal
system with three tiers, all built on the existing artifact model
(`RunRecord`, the artifact store, context manifests, identity, paired
statistics, and the promotion gate) rather than new infrastructure.

### Tier 1 — deterministic lifecycle conformance (every PR, no live model)

The reference loop (mini-services/terminus-control/src/agent/turn-lifecycle/)
runs fixed adversarial schedules plus seeded schedule permutations on a
virtual clock, as before. Added:

- a `cancellation` perturbation and an injected-clock `deadline_expired`
  perturbation (stale expiries must be absorbed; current expiries settle
  BUDGET_EXHAUSTED exactly once);
- an explicit deadline on the canonical spine so both deadline paths are
  exercised;
- a measured conformance report (`conformance.ts`,
  `terminus.lifecycle.conformance/v1`) that aggregates, per property, over
  the whole seeded schedule space: stuck-state rate (must be 0), duplicate
  absorption (must be 1.0), crash/replay reconstruction (must be 1.0),
  exactly one terminal/waiting outcome per schedule, bounded re-delivery
  convergence, cancellation correctness, and injected-clock deadline
  behavior.

Fast (CI budget 5k seeds in well under a second; `just
lifecycle-conformance` retains a 50k-seed report artifact under
`evals/results/lifecycle/`) and mandatory (`just test-reference-loop` runs
before assembled E2E).

### Tier 2 — small live-provider canary (relevant PRs)

Five compact task packages under
`python/forge_evals/evals/tasks/canary/` cover the archetypes where harness
regressions surface first:

| task | archetype |
|---|---|
| `diag-001` | read-only diagnosis (empty diff expected) |
| `edit-single-001` | single-file edit |
| `edit-multi-001` | multi-file edit |
| `test-repair-001` | failing-test repair (tests are the spec, untouched) |
| `repo-discovery-001` | repository discovery with incomplete initial context |

Success is decided by each task's deterministic grader (repository state,
hidden tests, scope checks). LLM judges may add diagnostics; they are never
the primary success condition.

`terminus-eval canary` runs both arms — the pinned baseline revision and the
candidate — over the same tasks, seeds, model snapshot, reasoning effort,
environment, and budget. The report
(`terminus.canary.comparison/v1`) enforces the model-fixed identity key
across arms, rejects identical commits, records every cell (missing runs are
reported, never dropped), and includes per-cell automatic trajectory,
context-manifest, and tool-sequence diffs (`forge_evals.trajectory_diff`).
Fixture mode (`--fixture-mode`) exercises the machinery offline; its report
is honestly ineligible for promotion because fixture identities carry
missing-field markers. Live mode needs two control planes
(`TERMINUS_BASELINE_URL` / `TERMINUS_CANDIDATE_URL`) and fails closed
without them (`just canary-live`).

### Tier 3 — larger held-out scheduled cohort

- **Held-out partitions** (`evals/holdout-partitions.yaml`,
  `forge_evals.holdout`): every (suite, task) cell is `dev`, `holdout`, or
  `blocked`. Blocked cells fail any run set that contains them; holdout
  cells must carry their partition stamp on the record; unlisted cells
  default to dev. Promotion reads holdout results only for the
  pre-registered comparison.
- **Cohort metrics** (`forge_evals.cohort_metrics`): resolved-task rate,
  false-completion rate, median/p95 latency, input/cached/reasoning/output
  tokens, cost per resolved task, tool calls per resolved task, verification
  cost share and false-block rate, context-compilation latency and
  selected-token count, provider retries, lifecycle recoveries, stuck-state
  rate, cache-prefix survival between turns, repair turns — each with
  repetitions and bootstrap CIs, sliced by cohort and archetype. Unmeasured
  is `None`, never zero.
- **Causal comparison** (`terminus-eval cohort-compare`,
  `forge_evals.cohort_compare`): paired per-(suite, task, seed) deltas with
  McNemar and bootstrap CIs, per-slice metric tables for both arms, and the
  automatic trajectory/manifest/tool-sequence comparisons per pair. Verdicts
  at small n honestly report `no_change` rather than reacting to single
  runs.
- **Promotion gate extension**: a seventh gate (`reliability`) consumes
  `ReliabilityEvidence` — false-completion, stuck-state, verification
  false-block, and cache-prefix survival deltas. A candidate regressing any
  of them beyond its margin is rejected regardless of mean primary-metric
  improvement; missing evidence leaves the gate silent (`n/a`), never
  passing.

Promotion continues to require everything ADR-0025 demanded, plus: no
unacceptable reliability regression, materially higher false completion is
auto-rejecting, excessive cost/latency remains Pareto-blocking, no benefit
on the intended task class fails the Pareto gate, and major regressions
elsewhere fail the regressions gate.

## Alternatives

- **More instrumentation first.** Rejected: the records already carry what
  the questions need; the gap was pairing, partitions, and gates.
- **LLM judges as primary success condition for the canary.** Rejected:
  judges are noisy and gameable; deterministic repository-state graders are
  cheap and reproducible.
- **Tuning candidates on holdout cohorts.** Rejected structurally: the
  partition registry blocks it and unstamped holdout records fail closed.
- **A separate evaluation database/service.** Rejected: `RunRecord` and the
  artifact store are already the evidence model; a second store would fork
  the evidence chain (ADR-0005).

## Consequences

- Every agent-behavior PR runs Tier 1 (existing gate, now with measured
  properties); relevant PRs run Tier 2; the scheduled nightly runs the Tier
  3 cohort and produces the comparison report automatically.
- The question "did this change improve Terminus?" is answered with paired,
  identity-locked, CI-carrying evidence per archetype and per cohort, not
  with intuition.
- Report schema versions (`terminus.lifecycle.conformance/v1`,
  `terminus.canary.comparison/v1`, `terminus.cohort.comparison/v1`) are the
  compatibility surface for downstream consumers.

## Security Impact

Low on the enforcement path: all three tiers live in the offline,
non-privileged eval plane (ADR-0003). Partition enforcement and the
reliability gate reduce the risk of shipping a candidate with a degraded
safety or reliability posture hidden behind a better mean score.

## Evaluation Plan

- Tier 1: `just test-reference-loop` (per PR), `just lifecycle-conformance`
  (retained report artifact).
- Tier 2: `just canary-fixture` (per PR machinery check), `just canary-live
  <baseline> <candidate>` (relevant PRs).
- Tier 3: `just eval-nightly-cohort` (scheduled), `just cohort-compare
  <baseline-dir> <candidate-dir>`; promotion decisions consume the report
  plus `ReliabilityEvidence`.

## Migration

No runtime surface changes. The new modules are additive; the promotion
gate's new gate is `n/a` for callers that do not supply reliability
evidence, so existing callers keep their verdicts until they opt in.

## Rollback

Revert the ADR and the new recipes; the existing gate set (ADR-0025)
remains fully operative. Report artifacts are additive outputs under the
gitignored `evals/results/` tree.

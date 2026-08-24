# ADR-0001: Optimize verified successful tasks per dollar-hour

- **Status:** ADOPTED
- **Date:** 2025-07-11
- **Decision owner:** product owner
- **Supersedes:** none
- **Related:** SPEC §1, §26.6

## Context

The Terminus product is a coding-agent operating system, not a benchmark entry or a research demo. Many existing harnesses optimize for raw task success on a single benchmark, hide cost behind "tokens" without breaking out compute/wall-clock/human attention, or aggregate everything into one number that conceals safety regressions. We need a primary metric that:

- rewards verified completion, not model-asserted completion;
- penalizes cost (model, compute, wall-clock, and human attention) so sophisticated features must earn their place;
- exposes safety regressions separately so a composite score cannot hide a security failure;
- supports ablation, replay, and feature-gating decisions.

SPEC §1 and §26.6 define this metric normatively.

## Decision

Adopt **verified successful tasks per dollar-hour** as the primary product success metric:

```
verified_successful_tasks
──────────────────────────────────────────────────────────────
model_cost + compute_cost + elapsed_time_cost + human_attention
```

The denominator MUST be reported as separate components as well as any composite. "Verified" requires verification evidence linked to the task's acceptance criteria (SPEC §17, §40). The product dashboard MUST include final/first-patch success, acceptance-criterion coverage, regression rate, changed-line/file excess, user corrections/approvals, token breakdown (input/output/cached/reasoning/tool-schema), context compilation overhead, latency, restart/resume success, unsafe attempts/policy denials/sandbox escapes, stale-context/stale-write incidents, plugin/MCP descriptor changes, external-integration maintenance cost, and feature-specific contribution through ablation or replay.

**No single aggregate score may conceal a safety regression.**

## Alternatives

- **Raw SWE-bench-style pass@1.** Rejected: hides cost, hides safety, encourages benchmark overfitting (Risk R10).
- **Tokens-per-task only.** Rejected: ignores human attention and compute; trivially gameable by hiding work in tool output.
- **Composite quality score with safety as a multiplier.** Rejected: a multiplier can hide a safety regression if the rest improves. Safety is reported separately.

## Consequences

- Every default feature must carry an evaluation record before promotion (ADR-0025).
- Memory, learned routing, parallel writers, and compression remain opt-in until their gates pass (ADR-0023, ADR-0022, ADR-0020, ADR-0024).
- The eval lab (Python) is a first-class subsystem, not an afterthought.
- The dashboard cannot ship without the full metric breakdown.

## Security Impact

None directly. The metric enforces that safety regressions are visible. The "unsafe attempts / policy denials / sandbox escapes" sub-metrics are release blockers if they regress.

## Evaluation Plan

- The Python eval lab (`python/forge_evals/`) produces RunRecords with the full denominator breakdown per SPEC §41.5.
- The promotion gate (SPEC §18.7, §41.12, §50) requires non-inferiority on safety sub-metrics before any feature is promoted.
- Each feature ADR references the cohort it must beat and the baseline it is compared against.

## Migration

N/A — this is the founding decision. All existing subsystems (kernel, control plane, eval lab) are built to serve this metric.

## Rollback

Cannot be rolled back without replacing the founding product contract. If the metric is found to be gameable, amend via a new ADR; do not silently weaken it.

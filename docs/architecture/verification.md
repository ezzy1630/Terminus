# Verification

This document is the deep dive for the verification subsystem (SPEC §17, §40). Verification is the engine that prevents false completion: a task is complete only when all required evidence-producing predicates pass. It is governed by ADR-0021 (task-specific verification DAG).

## Verification as a DAG (SPEC §17.1, §40.1)

A task's verification plan is a directed acyclic graph of predicates:

```
                 ┌─────────────────────┐
                 │  acceptance_criterion_1  │
                 └──────────┬──────────┘
                            │
       ┌────────────────────┼────────────────────┐
       ▼                    ▼                    ▼
 ┌──────────┐       ┌──────────┐        ┌──────────┐
 │ tests_pass│      │ lints_pass│       │ diagnostics_clean│
 └──────────┘       └──────────┘        └──────────┘
       │                    │                    │
       └────────────────────┼────────────────────┘
                            ▼
                 ┌─────────────────────┐
                 │     completion      │
                 └─────────────────────┘
```

Nodes are predicates; edges represent dependencies. Required predicates must pass; optional predicates may fail.

## Predicate types (SPEC §17.2, §40.2)

Standard library:

- `tests_pass` — test suite passes (with isolation, §40.8).
- `lints_pass` — linters pass.
- `typecheck_pass` — type checker passes.
- `diagnostics_clean` — no errors/warnings in changed files.
- `acceptance_criterion_satisfied` — acceptance criterion met (custom evaluator).
- `reviewer_approved` — reviewer findings all addressed.
- `no_security_findings` — security scan clean.
- `no_stale_writes` — all writes anchored to current source versions.
- `source_versions_match` — worktree matches recorded source versions.

Custom predicates are task-specific (e.g., "database migration applies cleanly").

## Evidence record (SPEC §17.3, §40.3)

Every predicate produces an evidence record:

```ts
{
  predicateId,
  status: "pass" | "fail" | "skipped" | "error",
  artifactRef,  // Immutable evidence (test output, lint output, etc.)
  timestamp,
  sourceVersions: { [path]: sha256 },
  duration,
  summary,
}
```

Evidence is immutable and artifact-backed.

## Acceptance-criterion mapping (SPEC §17.4, §40.4)

Each acceptance criterion in the task contract (Appendix E.1) maps to one or more predicates:

```
acceptance_criterion_1 → [tests_pass, acceptance_criterion_1_satisfied]
acceptance_criterion_2 → [acceptance_criterion_2_satisfied]
```

Required criteria must pass; optional criteria may fail. The mapping is part of the verification plan.

## Changed-code invalidation (SPEC §40.5)

When code changes, predicates depending on that code are invalidated and re-run. The invalidation graph:

- A file change invalidates predicates that read that file (tests, lints, typecheck, diagnostics).
- A dependency change invalidates dependents.
- A source-version mismatch invalidates all predicates that depend on the prior version.

This prevents stale evidence from masking regressions.

## Completion record (SPEC §17.4, §40.6)

A task is complete only when:

1. All required predicates pass.
2. All required acceptance criteria are satisfied.
3. No `no_security_findings` failure.
4. No `no_stale_writes` failure.
5. Reviewer findings (if any) are all addressed.

The completion record links to all evidence. The completion record is immutable.

```ts
{
  taskId,
  verificationPlanId,
  evidence: EvidenceRecord[],
  acceptanceCriteriaSatisfied: { [criterionId]: predicateId[] },
  completedAt,
  sourceVersions,
}
```

"No completion by assertion" (SPEC §26.3 #3) is enforced: a model's "I'm done" message does not complete the task.

## Durable completion admission

The control plane writes a completion record as `PREPARED` before registering
the candidate branch. That row contains the immutable completion data and the
branch identity, but it is not a completion claim. After the branch is
`ADMITTED`, `VerificationCoordinator` appends `task.completed` and, in one
writer transaction, moves the task to `COMPLETED`, the turn to `VERIFIED`, and
the record to `COMMITTED`.

Startup reconciliation replays this transition only when the branch is
already `ADMITTED` and the task/turn are still `VERIFYING`; it never reruns
provider inference. Missing, open, rejected, or mismatched branches quarantine
the prepared record for explicit reconciliation. Existing completion rows
default to `COMMITTED` through the additive migration.

## Durable repair continuations (SPEC §23, §37.14, §48.5)

Automatic verification repair is a continuation of the same task, not an
inference from the latest event. Scheduling writes a `repair_attempts` row in
the same transaction as the task transition and event. The row records the
parent turn, directive artifact, failed predicates and normalized signatures,
source/environment identity, attempt budget, and the eventual repair child
turn.

Each attempt owns one row in `leases`. Admission changes the attempt through
`PENDING` → `ADMITTED`; execution claims the lease and changes it to
`RUNNING`. Claims use the lease owner and monotonically increasing fencing
token. A live lease prevents a second continuation, including a duplicate
scheduler pass in the same process. Heartbeats renew the lease while the
repair actor runs; losing the lease aborts the actor and leaves recovery to a
later fenced claimant.

Startup recovery treats the durable attempt as authoritative across the
schedule, parent-state, child-admission, and execution windows. It resumes
only unambiguous repair boundaries, retries after a stale lease expires, and
quarantines malformed or uncertain later-stage state with an explicit terminal
reason. Legacy `REPAIR_PENDING` rows without an attempt are read from the
semantic event only to backfill the durable record once.

Repair attempts settle as `SUCCEEDED`, `FAILED`, `BLOCKED`, `ABORTED`, or
`SUPERSEDED`; they never make a task complete without the normal verification
DAG and completion admission.

## Review finding lifecycle (SPEC §40.7)

Reviewer findings (from ADR-0020 reviewer) have a lifecycle:

```
open → addressed → closed
open → wont_fix → closed (with justification)
open → false_positive → closed
```

Findings are tracked per task. Completion requires all `open` findings to be `addressed` or `wont_fix` (with justification).

## Verification isolation (SPEC §40.8)

Verification runs in an isolated environment:

- Separate sandbox (clean checkout, not the active worktree).
- Same source versions as the task.
- No access to the model or provider.
- No network (unless required by the predicate, e.g., integration tests).

This prevents the active worktree from masking issues (e.g., uncommitted changes that make tests pass).

## Flaky tests (SPEC §40.9)

Flaky tests are detected (pass on retry after fail) and quarantined, not silently retried. Quarantined tests:

- are tracked in a flaky-test registry;
- do not block completion;
- are reviewed periodically;
- must be fixed or removed before re-entering the suite.

## Evaluation plan (SPEC §48.11)

- False-completion tests: model claims completion without evidence; verification blocks.
- Changed-code invalidation tests: code change triggers predicate re-run.
- Verification isolation tests: corrupted worktree is detected.
- Flaky test handling tests: flaky test is quarantined, not retried.
- Reviewer trigger tests: high-risk task triggers reviewer.

Exit gate (M8, SPEC §48.11): verification prevents false completion in tests. Multi-agent mode improves the separable cohort and remains disabled or neutral on non-separable tasks.

## Standard predicates and the verification plan

The verification plan is task-specific. The `verification-plan` skill (`skills/builtin/verification-plan/SKILL.md`) helps the model produce a plan that maps acceptance criteria to predicates. The plan is validated for completeness (every required criterion has at least one predicate) and consistency (no impossible dependencies).

## Relation to orchestration (ADR-0020)

Verification is the gate to completion. The orchestrator cannot mark a task complete until the verification DAG passes. Loop protection (§37.14) interacts with verification: a failed verification that doesn't change approach triggers loop intervention.

# ADR-0021: Task-specific verification DAG

- **Status:** ADOPTED
- **Date:** 2025-07-11
- **Decision owner:** verification owner
- **Supersedes:** none
- **Related:** SPEC §17, §40

## Context

"No completion by assertion" (SPEC §26.3 #3) requires that task completion be supported by verification evidence linked to the task's acceptance criteria. A model producing a "I'm done" message is not completion. A single `tests pass` check is insufficient: not all acceptance criteria are testable by tests, and tests may not cover the changed code.

We need a verification engine that: (1) maps acceptance criteria to evidence-producing predicates, (2) schedules them as a DAG (some depend on others), (3) invalidates predicates when changed code is involved, (4) records evidence as artifacts, and (5) blocks completion if any required predicate fails.

## Decision

Adopt a **task-specific verification DAG** per SPEC §17 and §40:

1. **Verification graph** (SPEC §17.1, §40.1) — a DAG of evidence-producing predicates. Nodes are predicates (e.g., `tests_pass`, `lints_pass`, `diagnostics_clean`, `acceptance_criterion_N_satisfied`); edges represent dependencies.
2. **Predicate types** (SPEC §17.2, §40.2) — standard library: `tests_pass`, `lints_pass`, `typecheck_pass`, `diagnostics_clean`, `acceptance_criterion_satisfied`, `reviewer_approved`, `no_security_findings`, `no_stale_writes`, `source_versions_match`. Custom predicates are task-specific.
3. **Evidence rules** (SPEC §17.3, §40.3) — every predicate produces an evidence record: predicate ID, status, artifact ref, timestamp, source versions. Evidence is immutable.
4. **Acceptance-criterion mapping** (SPEC §40.4) — each acceptance criterion in the task contract maps to one or more predicates. Required criteria must pass; optional criteria may fail.
5. **Changed-code invalidation** (SPEC §40.5) — when code changes, predicates depending on that code are invalidated and re-run.
6. **Completion record** (SPEC §17.4, §40.6) — a task is complete only when all required predicates pass. The completion record links to all evidence.
7. **Review finding lifecycle** (SPEC §40.7) — reviewer findings (if any) have a lifecycle (open → addressed → closed).
8. **Verification isolation** (SPEC §40.8) — verification runs in an isolated environment (sandbox, separate worktree) to prevent it from masking issues.
9. **Flaky test handling** (SPEC §40.9) — flaky tests are detected and quarantined, not silently retried.

## Alternatives

- **Single `tests pass` check.** Rejected: insufficient; doesn't cover all acceptance criteria; doesn't handle changed-code invalidation.
- **Model self-report as evidence.** Rejected (SPEC §49.6): "No completion by assertion" (SPEC §26.3 #3).
- **Static verification plan (same for every task).** Rejected: not all tasks need the same predicates; wasted work or missed predicates.
- **No verification isolation.** Rejected: verification in the active worktree can mask issues; can't detect worktree corruption.

## Consequences

- Every task has a `verification_plan_id` linking to its DAG.
- Completion requires all required predicates to pass (SPEC §50.6).
- Verification evidence is immutable and artifact-backed.
- Changed code triggers predicate invalidation and re-run.
- The reviewer (ADR-0020) is triggered for high-risk tasks; findings have a lifecycle.
- Flaky tests are quarantined, not retried silently.

## Security Impact

Medium. Verification prevents false completion (SPEC §26.3 #3). Verification isolation prevents the active worktree from masking issues. Changed-code invalidation prevents stale evidence. No-security-findings predicate is a release blocker if it fails.

## Evaluation Plan

- False-completion tests: model claims completion without evidence; verification blocks.
- Changed-code invalidation tests: code change triggers predicate re-run.
- Verification isolation tests: corrupted worktree is detected.
- Flaky test handling tests: flaky test is quarantined, not retried.
- Reviewer trigger tests: high-risk task triggers reviewer.

## Migration

The verification engine is introduced in M8 (SPEC §48.11). OpenCode's completion model is replaced by the Terminus verification DAG (ADR-0002).

## Rollback

If a predicate proves too strict, relax it (do not disable the DAG). If the DAG proves too slow, run predicates in parallel or cache evidence (do not skip required predicates). The minimal baseline (ADR-0025) uses a minimal DAG (parse + diagnostics + narrow tests).

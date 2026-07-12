# Orchestration

This document is the deep dive for the orchestration subsystem (SPEC §14, §37). Orchestration owns task lifecycle, scope, delegation, worktrees, review, loop protection, and budget control. It is governed by ADR-0020 (single-agent default + expected-value scheduling) and ADR-0021 (task-specific verification DAG).

## Reliable task lifecycle (SPEC §37.1)

A task moves through phases with state-machine guards:

```
created → planning → executing → verifying → completing → completed
                 ↓           ↓          ↓           ↓
               paused      blocked    failed    cancelled
```

State transitions are guarded by property tests (SPEC §46.2). Non-terminal states are reconciled on restart (SPEC §48.5).

## Task contract (SPEC §14.3, §37.2, Appendix E.1)

```ts
{
  id, version,
  objective,
  userOutcome,
  nonGoals: string[],
  acceptanceCriteria: { id, statement, verificationHint, required }[],
  constraints: string[],
  assumptions: string[],
  unknowns: string[],
  allowedScope: { readPaths, writePaths, externalSystems },
  riskClass: "low" | "normal" | "high" | "critical",
  budget: { modelMicros, computeSeconds, wallClockSeconds, humanApprovals },
  changePolicy: { mayExpandScope, scopeExpansionRequiresUser },
}
```

The contract is versioned; changes create new versions. The scope ledger (§37.3) records allowed, proposed, observed, and effective resources.

## Scope ledger (SPEC §13.2, §37.3)

The scope ledger is the durable record of allowed, proposed, observed, and effective resources for a task. It is compiled from the task contract and updated as the task progresses. Scope expansion requires user approval (SPEC §26.3 #7, §3.5).

## Plan artifact (SPEC §37.4)

The plan artifact is a structured plan produced during the `planning` phase (mode `plan`, SPEC §26.2). It includes: steps, dependencies, estimated effort, risks, and acceptance-criterion mapping. The plan is validated for consistency before execution begins.

## Expected-value scheduler (SPEC §14.2, §37.5, ADR-0020)

The scheduler escalates to multi-agent only when:

```
expected_value = P(success improvement) × value(success)
expected_cost  = model_cost + compute_cost + wall_clock_cost + human_attention
escalate iff expected_value > expected_cost × threshold
```

The scheduler is deterministic (rule-based) initially; learned routing is OPEN (ADR-0022). Escalation decisions are logged and auditable.

## Default topology (SPEC §14.1, §37.6)

- **Single agent** (default).
- **+ read-only scout** (escalation; isolated worktree not required).
- **+ managed writer** (escalation; isolated worktree required).
- **+ reviewer** (triggered by risk class, not default).

## Delegation contract (SPEC §14.4, §37.7)

Delegations are typed:

- `scout` — read-only; produces a delegation-result with findings.
- `implementer` — writing worktree; produces a delegation-result with changes.
- `reviewer` — detached review; produces a delegation-result with findings.

Each delegation has a typed result schema (Appendix E.4).

## Worker result (SPEC §37.8)

```ts
{
  delegationId, workerId,
  status: "success" | "partial" | "failed" | "cancelled",
  summary,
  artifacts: ArtifactRef[],
  changedFiles,
  findings,
  budgetUsed,
  evidence: ArtifactRef[],
}
```

## Worktree ownership (SPEC §14.5, §37.9)

Managed writers get isolated Git worktrees (protected by `forge-git`). The integration coordinator merges worktrees back to the main branch. Worktree ownership prevents concurrent conflicting edits.

## Merge and integration (SPEC §37.10)

The integration coordinator:

1. Verifies each worker's worktree builds and passes tests.
2. Merges worktrees in dependency order.
3. Resolves conflicts (or escalates to user).
4. Runs integration verification (ADR-0021) after merge.

## Reviewer (SPEC §14.6, §37.11, §37.12)

The reviewer is triggered by:

- risk class `high` or `critical`;
- large diff (changed lines > threshold);
- security-sensitive paths;
- explicit user request.

The reviewer runs detached (separate worktree, no write access). Input: diff, task contract, context manifest. Output: findings (severity, file, line, description, recommendation). Findings have a lifecycle (open → addressed → closed, SPEC §40.7).

## User interaction policy (SPEC §37.13)

- Approvals are risk-based (not blanket).
- Scope is exact (not "do whatever it takes").
- Previews are clear (diff, command, destination).
- Policy-based safe defaults reduce approval fatigue (Risk R11).
- Approval metrics tracked.

## Loop detection (SPEC §14.7, §37.14)

Loop detection identifies:

- repeated identical tool calls;
- repeated failed edits to the same range;
- repeated failed tests with no code change;
- repeated provider requests with no progress.

Loop interventions (§37.15):

- surface the loop to the user;
- suggest a different approach;
- auto-pause after N iterations;
- budget enforcement.

## Budget control (SPEC §37.16)

Hard budgets:

- `modelMicros` — total model cost.
- `computeSeconds` — total compute.
- `wallClockSeconds` — total wall clock.
- `humanApprovals` — total approvals.

Budget exhaustion triggers cancellation (§37.17). Budgets are per-task and per-delegation.

## Cancellation (SPEC §37.17)

Cancellation:

- propagates to all child processes (process-tree kill);
- revokes active capabilities;
- reconciles effects (no blind retry of uncertain effects, SPEC §26.3 #9);
- produces a cancellation record with evidence.

## Product modes (SPEC §26.2)

| Mode | Writable effects | Network | Agents | Default verification |
|---|---:|---:|---:|---|
| `explain` | none | deny unless research requested | one | source coverage |
| `plan` | none | scoped | one + optional read-only scout | plan consistency |
| `edit` | active worktree only | deny by default | one | parse, diagnostics, narrow tests |
| `autonomous` | active isolated worktree | brokered allowlist | selective | task-specific verification DAG |
| `review` | none | deny by default | reviewer only | evidence-backed findings |
| `research` | artifact writes only | brokered allowlist | selective scouts | source quality and claim coverage |
| `eval` | disposable environment | suite-defined | suite-defined | hidden grader |
| `admin` | policy-defined | policy-defined | policy-defined | mandatory audit and approval |

`admin` MUST NOT be the default. The client MUST display the effective mode, sandbox backend, network policy, active worktree, budget, and whether enforcement is degraded.

## Evaluation plan (SPEC §48.11)

- One-agent vs. scout/writer/reviewer ablations on separable and non-separable cohorts.
- Expected-value scheduler: escalation decisions logged and auditable.
- Loop protection: bounded failure cases terminate within budget.
- Budget control: hard budgets enforced; cancellation reconciles.

Exit gate (M8, SPEC §48.11): verification prevents false completion in tests. Multi-agent mode improves the separable cohort and remains disabled or neutral on non-separable tasks.

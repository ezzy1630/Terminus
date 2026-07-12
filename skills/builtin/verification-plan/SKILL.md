# verification-plan

Build a task-specific verification DAG before declaring a task complete.

## When to use

Use this skill when a patch has been applied and the active task is moving
from `IMPLEMENTING` to `VERIFYING`. The skill inspects the change, the task
contract, and the risk class, then constructs a verification plan tailored to
the work.

## Inputs

- The active task contract (objective, acceptance criteria, risk class).
- The set of files modified by the patch transaction.
- The risk class: `low`, `normal`, `high`, or `critical`.

## Procedure

1. Always include the `parse` node — every workspace language touched must
   parse cleanly.
2. Always include the `diagnostics` node — narrow diagnostics on touched
   files. If no LSP is available, surface the degradation.
3. Include `narrow_tests` for ordinary changes; include `package_tests` for
   changes that touch public API; include `full_suite` for risk class `high`
   or `critical`.
4. For risk class `high` or `critical`, add `security_tests` and
   `detached_review` nodes. For changes touching auth, secrets, network, or
   sandbox code, also add `human_approval`.
5. Add `acceptance` node mapping each acceptance criterion to its evidence.
6. Compute the completion expression. Required nodes are AND'd; optional nodes
   do not block completion but their results are surfaced.
7. Persist the plan via `VERIFICATION_PLAN_CREATE`.

## Completion expression examples

- Ordinary code change: `parse && diagnostics && narrow_tests && acceptance`
- Security-sensitive change: `parse && diagnostics && narrow_tests && security_tests && detached_review && acceptance && human_approval`

## Important rules

- The verification plan must cover every required acceptance criterion. The
  context compiler's evidence-coverage pass will refuse to mark the task
  complete otherwise.
- A failed `parse` node blocks everything downstream; do not run tests in
  that case.
- A `detached_review` node runs in a read-only context with no model memory
  of the implementation; the reviewer only sees the diff and the contract.
- Never self-certify a security change. A `human_approval` node is mandatory
  for risk class `critical` touching auth/secrets/sandbox.

## Failure modes

- `INCOMPLETE_COVERAGE` — an acceptance criterion has no evidence path. Add
  a node or expand scope.
- `BLOCKED_BY_PARSE` — wait for the patch to parse; do not skip the node.
- `REVIEW_CONFLICT` — the reviewer proposed a veto; escalate to the user.

## Output

A `VerificationPlan` with nodes, edges, completion expression, and the
expected evidence per acceptance criterion. The plan is immutable once
created; subsequent patches create a new plan version.

# @forge/verification

Verification DAG engine: `VerificationPlan` builder, `VerificationNode` types
(command/diagnostic/diff_rule/human/external_query), `VerificationEngine` with
`evaluate(plan, workspaceRevision)` that runs nodes respecting dependencies,
parallel where safe, with retry policy. `CompletionRecord` builder that
requires all mandatory acceptance predicates pass. Changed-code invalidation.

Per SPEC §17, §40.

## Public API

- `buildVerificationPlan(input)` — validates DAG (no cycles, references exist).
- `VerificationEngine` with `evaluate`, `buildCompletionRecord`,
  `invalidateForChangedPaths`.
- `NodeExecutor` interface for plugging in command runners, diagnostic
  engines, etc.
- `evaluateCompletionExpression(expr, results)` — parses the simple boolean
  expression used by plans.

## Invariants

- A result is valid only for the source revision and environment it observed.
- Subsequent relevant edits invalidate affected nodes.
- A criterion without a verification mapping is explicitly `manual` or
  `unverifiable`, with reason. The harness MUST NOT convert "no test exists"
  into a pass.
- A flaky pass may not satisfy a high-risk criterion without policy approval.

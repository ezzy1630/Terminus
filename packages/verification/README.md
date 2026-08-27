# @terminus/verification

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
- `deriveVerificationNodes(input)` — selects typed verification predicates from
  acceptance criteria, changed paths, risk, repository signals, and available
  native test commands. It returns the nodes, required completion expression,
  and per-node selection rationale.
- `deriveRepairMetrics(input)` — derives first-proposal/repair success,
  repeated-failure, false-positive, outcome-classification, and exact repair
  usage deltas from durable facts. Missing provider cost or usage remains null.

## Invariants

- A result is valid only for the source revision and environment it observed.
- Subsequent relevant edits invalidate affected nodes.
- A criterion without a verification mapping is explicitly `manual` or
  `unverifiable`, with reason. The harness MUST NOT convert "no test exists"
  into a pass.
- A flaky pass may not satisfy a high-risk criterion without policy approval.
- Admission mode makes selected auxiliary checks required. Incremental mode
  keeps those checks optional and does not let them block required criteria.
- Derived node specifications record the derivation version and signal counts,
  so a persisted plan explains why each predicate was selected.

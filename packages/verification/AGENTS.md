# @forge/verification — local rules

## Non-negotiable

- DAG must be acyclic; `buildVerificationPlan` rejects cycles.
- A failing test is NOT retried until green by default; flake policy applies.
- The harness MUST NOT convert "no test exists" into a pass.
- A `CompletionRecord` cannot be built while any acceptance criterion is
  `unsatisfied`.

## What NOT to add

- Direct command execution (use `NodeExecutor`).
- Filesystem or process access.

# @terminus/context-compiler — local rules

## Non-negotiable

- No direct DB writes. Use `ContextStore`.
- Manifest MUST be persisted before the provider request.
- Never silently pretend evidence coverage exists.
- Complete episode integrity: a tool_call episode always includes both call
  and settled result.
- Hard-required fragments (authority ≥ 80) bypass scoring but still go through
  confidentiality filtering.

## Style

- Scoring weights are versioned policy parameters; do not learn them online.
- Greedy budget allocation is acceptable initially; the interface MUST permit
  later DP/learned policies.
- Record each generated query and its reason.

## What NOT to add

- Provider SDK imports (use the `ProviderRenderer` interface).
- Network or filesystem access.
- Direct secret reads.

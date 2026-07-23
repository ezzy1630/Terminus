# @terminus/memory — local rules

## Non-negotiable

- Disabled by default. The harness MUST surface `enabled: true` as an explicit
  decision. M10 exit gate may pass on fixtures; product default stays off until
  an explicit promotion decision (ADR-0023).
- Never extract candidates from incomplete tasks or raw secret content.
  Privacy filter runs before persistence; incomplete provenance is rejected.
- Consolidation MUST be lease-protected inside a `networkAllowed: false`
  curator sandbox.
- A memory cannot override current repository state or higher authority.
- Retrieval explanations MUST expose why / source / scope / confidence /
  freshness. Semantic retrieval stays opt-in.
- Harmful-use telemetry MUST auto-quarantine at threshold.
- Procedure→skill promotion requires verified repeated success, tests, and
  approval — memory text alone is never executable authority.

## What NOT to add

- Network access from the curator.
- Cross-workspace sharing by default.
- User preference promotion from one ambiguous observation.
- Enabling memory by default without a passed harm/utility gate and ADR update.

# @forge/memory — local rules

## Non-negotiable

- Disabled by default. The harness MUST surface `enabled: true` as an explicit
  decision.
- Never extract candidates from incomplete tasks or raw secret content.
- Consolidation MUST be lease-protected.
- A memory cannot override current repository state or higher authority.

## What NOT to add

- Network access from the curator.
- Cross-workspace sharing by default.
- User preference promotion from one ambiguous observation.

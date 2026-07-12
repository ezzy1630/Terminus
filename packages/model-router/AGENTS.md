# @forge/model-router — local rules

## Non-negotiable

- Routing is deterministic. No learned router (per §38.4 EXPERIMENTAL).
- Never select a model that violates the confidentiality policy.
- Never silently downgrade a high-risk reviewer or change privacy class.
- Fallback MUST record the original provider/model, reason, compatibility
  changes, and whether user consent is required.

## Style

- Scoring weights are versioned policy parameters; do not learn them online.
- `meetsMinimum` is a hard filter; scoring is only for ranking among eligible
  models.

## What NOT to add

- Network calls or provider SDK imports.
- Online weight updates.

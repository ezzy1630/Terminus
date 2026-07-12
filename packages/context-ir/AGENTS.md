# @forge/context-ir — local rules

## Non-negotiable

- No I/O.
- No provider-specific shapes.
- Schemas MUST validate every field. Use zod, not just types.
- `computeStablePrefixHash` MUST be deterministic.
- Never silently alter exact fragments.

## Style

- Helpers are pure functions.
- Numeric authority is in [0, 100]; selection features are real numbers in
  [0, 1] unless noted.
- Always return readonly arrays.

## What NOT to add

- Provider adapters or renderers (use `@forge/provider-*`).
- Database access.
- Logging side effects.

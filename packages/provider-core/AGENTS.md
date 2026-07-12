# @forge/provider-core — local rules

## Non-negotiable

- No network calls. Adapters implement `ProviderTransport`.
- No provider-specific request bodies. Those live in `@forge/provider-*`.
- Never silently downgrade privacy class.
- Cost anomalies MUST be surfaced.

## Style

- All token counts are `TokenCount` (bigint). All money is `Micros` (bigint).
- Renderers extend `BaseProviderRenderer` for default behavior.
- `compatibility()` returns structured incompatibilities — no string parsing.

## What NOT to add

- HTTP clients.
- Provider SDK imports.
- Direct secret access.

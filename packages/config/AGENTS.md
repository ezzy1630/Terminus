# @forge/config — local rules

## Non-negotiable

- Every external/persisted config value MUST go through `forgeConfigSchema.parse`.
- Lower layers (organization, defaults) CANNOT be weakened by higher layers.
  Use `nonOverridable` to mark paths that higher layers may not loosen.
- Secrets never appear in config files. Reference them via `secret://` URIs.

## Style

- Add new fields as `.default(...)` so layer-0 defaults always parse.
- Use enums for restricted string values.
- Numeric limits are integers (use `z.number().int().positive()`).

## What NOT to add

- Direct file reads. The caller supplies `ConfigSource.value` (parsed object).
- Network fetches.
- Environment variable reads (those live in the bootstrap that constructs
  `ConfigSource`s).

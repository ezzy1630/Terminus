# @terminus/config

Layered typed configuration for Terminus.

Per SPEC Appendix F, configuration is layered in the order:
compiled secure defaults < organization policy < user configuration <
workspace configuration < session/task configuration. Lower layers cannot
weaken non-overridable controls.

## Public API

- `forgeConfigSchema`: the zod schema for the entire Terminus config (Appendix F).
- `ForgeConfig`: the parsed config type.
- `compiledDefaults()`: returns the layer-0 defaults.
- `mergeConfigLayers(sources)`: merges layers, recording provenance and
  warnings for any attempted weakening of non-overridable paths.
- `loadConfig(source)`: convenience for a single layer on top of defaults.
- Sub-schemas: `kernelConfigSchema`, `storageConfigSchema`,
  `providersConfigSchema`, `routingConfigSchema`, `contextConfigSchema`,
  `aciConfigSchema`, `sandboxProfileConfigSchema`, `policiesConfigSchema`,
  `orchestrationConfigSchema`, `verificationConfigSchema`,
  `extensionsConfigSchema`, `budgetsConfigSchema`.

## Invariants

- Validation is mandatory: any untrusted input goes through `forgeConfigSchema.parse`.
- `nonOverridable` paths cannot be weakened by higher layers.
- Provenance is inspectable per field.

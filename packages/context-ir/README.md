# @terminus/context-ir

Context IR schemas and helpers — context fragment types, source descriptors,
exactness classes, trust/confidentiality/injection labels, freshness,
invalidation rules, selection features, dependencies, world-state observation
interface, context epoch snapshot, context budget, and manifest builder.

Per SPEC §8 and §33. Pure data — no I/O.

## Public API

- Re-exports context-related types from `@terminus/domain`.
- Schemas: `contextFragmentSchema`, `sourceDescriptorSchema`,
  `freshnessSchema`, `invalidationRuleSchema`, `selectionFeaturesSchema`,
  `contextScopeSchema`, `worldStateObservationSchema`,
  `worldStateSnapshotSchema`, `contextDirectiveSchema`,
  `contextEpochSnapshotSchema`, `contextManifestEntrySchema`,
  `contextManifestOmissionSchema`, `contextCachePlanSchema`.
- Types: `WorldStateSection`, `WorldStateObservation`, `WorldStateSnapshot`,
  `ContextEpochSnapshot`, `ContextDirective`, `ContextBudget`,
  `ManifestBuilderInput`.
- Builder: `buildManifest(input)` constructs a `ContextManifest` from selected
  fragments, cache plan, and reserves.
- Helpers: `isHardRequired`, `isConfidentialityAllowed`, `isFreshAgainst`,
  `computeStablePrefixHash`, `computeContentHash`, `canonicalJson`.

## Dependencies

`@terminus/domain`, `zod`.

## Invariants

- The Context IR is provider-neutral. Provider-specific shapes live in
  `@terminus/provider-*`.
- A fragment's source URI + version MUST be sufficient to determine staleness.
- Stable-prefix hashes preserve rendered order and use canonical SHA-256
  content identity.
- `buildManifest` does not persist; the caller persists before sending the
  provider request.

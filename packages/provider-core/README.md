# @terminus/provider-core

Provider-neutral broker contracts: `Provider`, `ProviderRenderer`, capability
snapshots, request/response shapes, usage/cost records, continuation decisions,
confidentiality policy enforcement, cost accounting.

Per SPEC §15 and §38. No network calls — adapters handle the wire.

## Public API

- Snapshots: `ProviderCapabilitySnapshot`, `ModelCapabilitySnapshot`,
  `ContextWindow`, `ContinuationProfile`, `CachingProfile`,
  `ReasoningProfile`, `ProviderEconomics`, `ProviderReliability`,
  `ProviderPolicy`.
- Wire shapes: `ProviderRequest`, `ProviderResponse`, `ProviderResponseChunk`,
  `ProviderToolSchema`, `ProviderRenderedBlock`, `ProjectedResponse`,
  `UsageRecord`, `CostRecord`, `ContinuationDecision`.
- Renderer: `ProviderRenderer` interface and `BaseProviderRenderer` abstract
  class with default `compatibility` and `continuationPolicy`.
- Profiles: `ProviderRenderingProfile`, `ProviderProfileBundle`, and
  `defineProviderProfileBundle(...)` bind provider-owned rendering data to a
  neutral routing profile.
- `Provider`, `ProviderTransport`.
- `ConfidentialityPolicy`, `isConfidentialityAllowed`,
  `filterByConfidentiality`.
- `computeCost(input)` for cost accounting with anomaly detection.

## Invariants

- The canonical domain MUST NOT contain provider-specific request bodies. This
  package exposes interfaces; concrete bodies live in `@terminus/provider-*`.
- Concrete model catalogs and rendering values live in `@terminus/provider-*`;
  the canonical domain keeps only opaque references.
- Never silently downgrade a high-risk reviewer or change privacy class.
- Cost anomalies are surfaced, not silently swallowed.

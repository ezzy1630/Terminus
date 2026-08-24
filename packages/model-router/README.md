# @terminus/model-router

Deterministic routing + escalation. Tasks request capabilities rather than
model names; the router ranks eligible models by cohort performance, health,
predicted cost, latency, cache reuse, and policy. Escalation is deterministic.

Per SPEC §38.3 and §38.4. A learned router is `EXPERIMENTAL` and not
implemented here.

## Public API

- `RouteProfile`, `CapabilityRequirements`, `RoutingPreferences` — what tasks
  request.
- `ModelHealth`, `ModelCohortStats` — runtime inputs to the router.
- `Router` with `route(input)` and `escalate(current, input, reason)`.
- `RoutingDecision`, `RoutingCandidate`.
- `FallbackRecord`, `FallbackReason`, `recordFallback(...)`.
- `ProfileRegistry`, `PosteriorTracker`, and `StageRouter` for injected,
  provider-neutral `ModelProfile` values.

## Invariants

- Never silently downgrade a high-risk reviewer or change privacy class.
- A model that violates the confidentiality policy is never selected.
- Escalation is deterministic — no learned router.
- Concrete model catalogs come from the composition root. This package has no
  bundled vendor profiles or default registry.

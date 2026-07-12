# ADR-0022: Deterministic model routing before learned routing

- **Status:** ADOPTED
- **Date:** 2025-07-11
- **Decision owner:** provider owner
- **Supersedes:** none
- **Related:** SPEC §15, §38, §49.5

## Context

Model routing — choosing which model/provider to use for a given request — has a large impact on cost and success. A learned router (trained on local data) could in principle optimize routing, but: (1) local data is initially insufficient or contaminated, (2) a learned router is opaque and hard to audit, (3) provider APIs and models change (SPEC §3.x, J.2), so a learned router can silently degrade, (4) a learned router that overfits public benchmarks can mask cohort regressions (Risk R10).

We need routing that is deterministic, auditable, and safe to ship as a default. Learned routing is OPEN (SPEC §49.5) but cannot be the default until its gate passes.

## Decision

Adopt **deterministic model routing before learned routing** per SPEC §15 and §38:

1. **Deterministic routing profiles** (SPEC §38) — routing is rule-based: per-role, per-request-type, per-task-cohort. Profiles are versioned and inspectable. Examples: `cheap-fast` (small model for trivial requests), `coding-default` (mid-tier coding model), `review` (strong model for review), `escalation` (strongest model when the cheap one fails).
2. **Fallback** (SPEC §38) — if the primary model is unavailable, fall back to a secondary. Fallback is observable and policy-compliant.
3. **Per-role/request/task budgets** (SPEC §38) — each role/request/task has a model budget (micros). The router enforces it.
4. **Provider health, queues, rate limits, circuit breakers** (SPEC §38) — the router tracks provider health and routes around unhealthy providers.
5. **Capability snapshots** (SPEC §38) — provider/model capabilities are snapshotted and tested. The router consumes the snapshot, not the live provider API, so provider changes don't silently degrade routing.
6. **Learned router is OPEN** (SPEC §49.5) — a learned router may be introduced behind a flag after the deterministic router is proven. It cannot be the default until its gate passes (cohort regressions, audit, transparency).
7. **No silent model swap** — a model swap mid-task is recorded in the context manifest (ADR-0010) and is auditable.

## Alternatives

- **Learned router from day one.** Rejected: insufficient/contaminated local data (Risk R10); opaque; provider API changes cause silent degradation.
- **Single model for everything.** Rejected: cost; doesn't exploit provider strengths; loses fallback.
- **Provider-native routing.** Rejected (SPEC §49.6): provider concepts leak into canonical domain; cannot switch providers.
- **Random/round-robin routing.** Rejected: no optimization; no fallback semantics.

## Consequences

- The `packages/model-router` package owns deterministic routing profiles.
- Provider capability snapshots are pinned and tested (SPEC §50.7).
- Fallback is observable (SPEC §50.7).
- Cost accounting reconciles (SPEC §50.7).
- Hard budgets are enforced (SPEC §50.7).
- A learned router, if introduced, is behind a flag and cannot mask cohort regressions.

## Security Impact

Low. Routing does not directly affect security, but provider confidentiality policy (SPEC §36.18) blocks disallowed providers. The router must respect this. No silent model swap ensures audit completeness.

## Evaluation Plan

- Routing profile tests: each profile routes to the expected model.
- Fallback tests: primary unavailable → secondary used; observable.
- Capability snapshot tests: snapshot matches live provider (where testable).
- Cost reconciliation tests: observed cost matches recorded cost.
- (If learned router is introduced) cohort regression tests: learned router does not regress any cohort vs. deterministic router.

## Migration

Deterministic routing is introduced in M7 (SPEC §48.10). A learned router, if introduced, is M10+ and behind a flag.

## Rollback

If a routing profile causes regressions, revert the profile (do not disable routing). If the learned router is introduced and regresses a cohort, disable it (fall back to deterministic). Do not silently re-enable the learned router.

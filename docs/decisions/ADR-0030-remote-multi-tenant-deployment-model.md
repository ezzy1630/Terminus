# ADR-0030: Remote multi-tenant deployment model

- **Status:** OPEN
- **Date:** 2025-07-11
- **Decision owner:** release owner
- **Supersedes:** none
- **Related:** SPEC §26.5, §36.19, §49.4 (R12), §48.14

## Context

Forge is local-first (SPEC §26.1). The first production release is single-user. But there is product pressure to expose a shared daemon for teams, CI, and remote execution. SPEC §26.5 explicitly lists "full enterprise multi-tenancy before single-user isolation and recovery are proven" as a non-goal. Risk R12 (SPEC §49.4) calls out "Remote multi-tenancy is added prematurely" as a critical-impact risk.

Multi-tenancy introduces: cross-tenant data access risk, quota/admission control, per-tenant encryption keys, per-tenant audit, tenant isolation in execution and storage, and a much larger attack surface. None of this can be added safely before single-user isolation, recovery, and the non-bypassability suite are proven.

## Decision (OPEN)

This ADR is OPEN. The decision owner is the release owner. The decision will be made after M11 (SPEC §48.14) ships remote kernel mTLS, remote workspace/environment descriptors, and single-user isolation/recovery tests pass.

Candidate models under evaluation:

1. **Single-tenant remote** — one Forge instance per tenant. Simplest; strongest isolation; highest operational cost. The baseline.
2. **Multi-tenant with isolated execution** — shared control plane, isolated kernel per tenant (container/micro-VM per tenant). Medium complexity; strong isolation.
3. **Multi-tenant with shared kernel** — shared control plane and kernel, with per-tenant quotas, keys, and audit. Lowest cost; weakest isolation; highest risk.
4. **No multi-tenancy** — single-tenant only. The safest baseline.

Selection criteria:
- Isolation strength (cross-tenant data access tests, Appendix I.1).
- Operational cost (per-tenant overhead).
- Quota/admission control (SPEC §47.10).
- Per-tenant encryption keys.
- Per-tenant audit.
- Threat review (SPEC §49.4 R12).
- Promotion gate per ADR-0025 (with extra stringency for security).

The multi-tenant model, if chosen, requires:
- explicit non-goal lift (SPEC §26.5 amendment via new ADR);
- threat review and acceptance;
- tenant isolation tests (Appendix I.1);
- per-tenant quotas, keys, and audit;
- mTLS with per-tenant identity;
- remote workspace/environment descriptors (SPEC §48.14).

## Alternatives

- **Multi-tenancy on by default.** Rejected (SPEC §26.5, §49.4 R12): premature; critical risk.
- **Shared kernel multi-tenancy.** Rejected for now: weakest isolation; highest risk.
- **No remote execution at all.** Rejected: legitimate use cases (CI, remote work) exist; single-tenant remote is safe.
- **Pick a model without evaluation.** Rejected: must be evidence-based; must pass threat review.

## Consequences (once a model is chosen)

- The chosen model is implemented in M11+ (SPEC §48.14) or a later milestone.
- Tenant isolation tests (Appendix I.1) are required.
- Per-tenant quotas, keys, and audit are implemented.
- mTLS with per-tenant identity is required.
- The non-bypassability tests (SPEC §27.4) must pass per-tenant.
- The release gate (SPEC §46.18) includes the multi-tenant threat review.

## Security Impact

Critical. Multi-tenancy is the highest-risk feature in Forge (Risk R12). Cross-tenant data access is a release blocker. The threat model (SPEC §36.2) includes "another tenant in a shared execution environment" as a threat actor. The chosen model must demonstrate isolation against this threat.

## Evaluation Plan

- Tenant isolation tests (Appendix I.1): cross-tenant data access, cross-tenant effect, cross-tenant audit leakage.
- Quota/admission tests: per-tenant quotas enforced; admission control works.
- Encryption tests: per-tenant keys; cross-tenant decryption fails.
- Audit tests: per-tenant audit complete; no cross-tenant leakage.
- Threat review: external review of the chosen model.
- Promotion gate per ADR-0025 (with extra stringency for security).

## Migration

The chosen model is implemented after M11 (SPEC §48.14) and after single-user isolation/recovery are proven. The migration is a new milestone (post-M12) or a later release.

## Rollback

If multi-tenancy proves unsafe (cross-tenant leak, isolation failure), revert to single-tenant remote (model 1) or single-tenant only (model 4). Do not silently keep a leaking multi-tenant deployment running. Incident process applies (`docs/runbooks/security-incident.md`).

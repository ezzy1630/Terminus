# ADR-0030: Remote multi-tenant deployment model

- **Status:** ADOPTED (single-tenant remote)
- **Date:** 2025-07-11
- **Adopted:** 2026-07-23
- **Decision owner:** release owner
- **Supersedes:** none
- **Related:** SPEC §26.5, §36.19, §49.4 (R12), §48.14

## Context

Terminus is local-first (SPEC §26.1). The first production release is single-user. But there is product pressure to expose a shared daemon for teams, CI, and remote execution. SPEC §26.5 explicitly lists "full enterprise multi-tenancy before single-user isolation and recovery are proven" as a non-goal. Risk R12 (SPEC §49.4) calls out "Remote multi-tenancy is added prematurely" as a critical-impact risk.

## Decision

**Adopt model 1: single-tenant remote** for M11.

- One Terminus control + kernel deployment per tenant.
- Remote kernel transport is gRPC over mTLS (`TERMINUS_KERNEL_MTLS=1`).
- Kernel / server / control identities bind capability tokens and cert peers.
- Remote environment descriptors and digest-pinned execution pools are required.
- Multi-tenant shared control plane / shared kernel remains a non-goal until
  single-tenant isolation and recovery exit gates pass.

Candidate models 2–3 stay deferred. Model 4 (no remote) is rejected: CI and
remote work need single-tenant remote.

## Consequences

- `crates/terminus-remote` and `@terminus/remote` own identities, descriptors,
  quotas, settlement-on-disconnect, collab handoff, and audit export controls.
- Isolation tests treat foreign kernel identities and cert fingerprints as
  hard failures.
- Disconnect while an effect is `Started` yields `Unknown` / `ManualReview`,
  never silent `Settled`.
- Promoting to multi-tenant requires a new ADR amending SPEC §26.5, threat
  review, and Appendix I.1 tenant isolation tests.

## Security Impact

High. Single-tenant remote removes cross-tenant shared-kernel risk while still
requiring mTLS + capability tokens. Cross-deployment identity mix-ups are
release blockers.

## Evaluation Plan

- Exit-gate tests in `crates/terminus-remote/tests/exit_gate.rs` and
  `packages/remote/src/exit-gate.test.ts`.
- mTLS material validation and peer fingerprint checks.
- Digest-pin enforcement in `terminus-sandbox-container`.

## Migration

Operators enable remote mode with `TERMINUS_KERNEL_MTLS=1` and PEM paths.
Local UDS mode remains the default for single-machine installs.

## Rollback

Disable mTLS env flags and fall back to UDS. Do not introduce shared-kernel
multi-tenancy as a silent default.

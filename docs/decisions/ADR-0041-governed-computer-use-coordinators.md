# ADR-0041: Governed computer-use coordinators

- **Status:** ADOPTED
- **Date:** 2026-08-23
- **Decision owner:** runtime architecture owner + security owner
- **Supersedes:** none
- **Related:** ADR-0004, ADR-0015, ADR-0016, ADR-0021, `Terminus — Research/SPEC.md` §25, roadmap Phase 10

## Context

Browser and desktop automation combine uncertain perception with consequential
effects. A click described by coordinates alone can target stale or ambiguous
UI; a submit retry can duplicate an external effect; a human takeover can race
the agent; and browser state can cross confidentiality or tenant boundaries.
Treating screenshot automation as a privileged monolith would bypass the
kernel, evidence, and authorization model.

## Decision

1. TypeScript computer-use modules are pure coordinators. Process, filesystem,
   socket, credential, browser, desktop, and external-state effects remain
   kernel-authorized operations with settlement evidence.
2. An observation fuses screenshot, DOM, accessibility, viewport, and source
   identity into one immutable evidence record. Missing modalities remain
   explicit; fusion cannot invent success or certainty.
3. Actions target semantic element identity plus observation version. The
   verifier rejects stale, occluded, moved, low-confidence, or ambiguous
   targets before an effect is proposed.
4. Submission is an uncertainty-sensitive effect. An ambiguous result is
   reconciled from evidence before retry; it is never blindly submitted again.
5. Browser/desktop environments are leased from policy-bound pools with exact
   image/profile identity, bounded lifetime, tenant/confidentiality scope, and
   explicit cleanup. A lease is not host authority.
6. Human takeover is a fenced state transition. Agent actions stop before
   control transfers and resume only from a new observation after explicit
   handback.
7. Connector, research, and incident profiles declare allowed destinations,
   data classes, credentials, retention, and evidence requirements. Data-flow
   policy evaluates every cross-boundary transfer.
8. Public clients cannot originate trusted observations, verifier evidence,
   DLP results, authorization instances, or effect-settlement transitions.
   Those records are admitted only from an authenticated kernel or adopted
   trusted-adapter receipt whose artifact identity, content hash, task,
   principal, destination, and operation are verified together.
9. A standalone control plane without those receipt verifiers exposes the
   read/proposal surfaces but returns a typed `503` for trusted admission,
   dispatch, authorization, settlement, pool leasing, and reconciliation. It
   must not substitute process-local records or caller assertions.

## Alternatives

- **Coordinate-only clicking.** Rejected because layout drift and overlays make
  exact-effect authorization impossible.
- **Unrestricted browser process in the control plane.** Rejected because it
  gains ambient network, credential, and external-state authority.
- **Retry on timeout.** Rejected because an unknown submission may already have
  settled.
- **Human and agent share control concurrently.** Rejected because ordering and
  accountability become indeterminate.
- **Authenticated caller as verifier.** Rejected because authentication proves
  caller identity, not the truth of an observation, effect result, DLP scan, or
  acceptance claim.

## Consequences

- Computer use can share the task, evidence, approval, and recovery model with
  coding effects.
- Coordinators are testable without granting local host authority.
- Real execution requires kernel/browser/desktop adapters, pool operations, and
  hostile-environment tests; pure contract tests cannot satisfy Phase 10.
- Observation storage has material privacy and retention cost.

## Security and privacy impact

Credentials remain brokered and destination-bound. Observations carry trust
and confidentiality labels and may require redaction before artifact storage.
Pool leases prevent tenant/profile reuse. Ambiguous targets, missing policy,
unknown settlement, stale observations, caller-authored verifier results, and
unverified adapter receipts fail closed. Raw clipboard or secret-adjacent
payload samples never enter the TypeScript public API.

## Verification and evaluation

- Unit tests cover modality fusion, semantic target rejection, pool leasing,
  takeover fencing, data-flow decisions, profile validation, and ambiguous
  submission reconciliation.
- Adversarial tests must include overlay interception, stale DOM/accessibility
  trees, moved targets, poisoned page text, credential exfiltration, duplicate
  submit, takeover races, and failed cleanup.
- Phase 10 remains blocked until governed real browser and desktop tasks beat
  coordinate-only and single-modality baselines at fixed budgets without
  security, privacy, cost, or latency regression.

## Migration and rollback

The coordinators and schemas are additive. Real adapters remain disabled by
default until their security and eval gates pass. A coordinator can be removed
without changing the kernel effect contract; weakening semantic verification,
settlement reconciliation, or takeover fencing requires a superseding ADR.

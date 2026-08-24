# ADR-0042: Trusted state admission and fail-closed standalone mutations

- **Status:** ADOPTED
- **Date:** 2026-08-23
- **Decision owner:** runtime architecture owner + security owner
- **Supersedes:** none
- **Related:** ADR-0008, ADR-0021, ADR-0041, SPEC §28, SPEC §29.6, SPEC §31

## Context

Authentication identifies a control-plane caller. It does not prove that an
effect settled, a worker completed an attempt, an authorization was consumed by
the exact prepared operation, or an imported snapshot is authentic. Accepting
those assertions over the public bearer-authenticated API lets a client create
completion-shaped state without kernel, verifier, or policy-broker evidence.

Portable import has the same problem at larger scale: an unverified export can
contain terminal tasks and arbitrary semantic events. Replaying unvalidated
event snapshots then turns the forged history into authoritative in-memory
state.

## Decision

1. Public clients may request or reference state transitions, but cannot author
   authoritative settlement, verification, authorization-consumption, or
   completion results.
2. Effect settlement and task-attempt settlement require an immutable receipt
   whose subject, operation, task, principal, worker fencing token, and content
   hash are verified by a trusted kernel or adopted adapter.
3. Authorization creation, consumption, and revocation are policy-broker
   operations. Consumption is bound to the exact prepared effect and cannot be
   performed by a generic public bearer.
   Approval records retain a versioned, normalized, secret-redacted operation
   binding. The server computes `operation_hash` from its canonical JSON; list,
   event, and resolve surfaces carry that same binding. Resolution must present
   the exact hash and atomically match a pending, unexpired record. Legacy rows
   without a valid binding remain denyable but cannot authorize an effect.
4. Portable import requires a signed export, a trusted signature verifier, full
   schema and referential-integrity validation, and an isolated staging store
   before atomic admission.
5. The standalone control plane returns a typed `503` and performs no mutation
   while these trusted verifiers and brokers are unconfigured.
6. ARP replay validates every aggregate snapshot with its canonical schema.
   Unknown, malformed, or JSON-wire-incompatible snapshots are ignored rather
   than inserted with a cast.
7. Legacy public routes receive the same trust treatment as v2 routes. A legacy
   endpoint is not an exception to the effect or evidence boundary.
8. Checkpoint admission accepts lineage identifiers, not caller-authored state.
   The control plane derives canonical `CheckpointContent` from the active task
   contract and persisted task/effect/approval state, ingests those exact bytes,
   and creates a durable kernel artifact-owner link before publishing the
   checkpoint row. Before a checkpoint enters model context, the control plane
   must validate its artifact URI, recompute its SHA-256 identity, strictly
   decode its bounded schema, require canonical encoding, and revalidate it
   against the active contract and known source versions.
9. Checkpoint content is linked at the kernel before a control-plane row can
   become visible, eliminating the ingest-to-link garbage-collection window.
   The link persists the authoritative task binder and rejects owner-ID,
   task-ID, or content-hash rebinding. The control plane then records a hidden
   `PREPARED` intent, refetches and hashes the exact bytes during recovery, and
   commits `checkpoint.created` plus the visible `COMMITTED` state in one
   database transaction. Startup compares kernel checkpoint links to control
   rows; task-bound orphans older than the admission grace period are removed,
   while conflicting links quarantine the row and remain retained for review.
10. Local workspace admission is two-phase. The kernel first canonicalizes the
    requested root without mutating its registry. The control plane compares
    that canonical identity and requested trust against its durable workspace
    row, then asks the kernel to register or adopt the authoritative ID. A
    symlink or path spelling is not a second identity; canonical root and trust
    determine whether an existing registration matches.

## Consequences

- Export remains available; import is intentionally unavailable until its
  signed staging pipeline exists.
- The standalone UI and public clients can inspect proposed effects and running
  attempts but cannot manufacture their settlement.
- Existing unsigned imports and caller-authored settlement requests fail
  closed. This is a compatibility break for unsafe prototype behavior.
- Prototype checkpoints containing fabricated dirty-state, workspace, episode,
  or continuation claims are no longer admitted. Existing malformed or stale
  checkpoint artifacts stop context compilation instead of becoming trusted
  prompt state.
- Linking before row publication prevents a live checkpoint from referencing
  collectable content. Startup reconciliation bounds orphan-link retention.
- The kernel persists checkpoint owner-task bindings and treats the first
  trusted admission as immutable. Control-plane lineage validation and exact
  token/context binding prevent cross-task owner-label substitution.
- Workspace trust conflicts are detected before kernel registry mutation, and
  standalone upgrades preserve the control plane's existing workspace ID even
  when a caller opens the root through an equivalent symlink.
- Phase 2, Phase 3, and Phase 10 exit gates remain blocked until the trusted
  adapters and recovery drills exist.

## Verification

- Public schema tests reject caller-authored verifier and observation fields.
- Control-plane integration tests must prove that unsigned import, legacy
  settlement, attempt settlement, and public authorization consumption return
  an unavailable error without changing persisted or replayed state.
- Checkpoint integration tests must reject extra caller state, verify canonical
  bytes and SHA-256 metadata before and after restart, and prove that the kernel
  retains an explicit owner link for admitted content.
- Replay tests must include malformed snapshots for every aggregate kind and
  bigint-backed JSON fields.

## Rollback

Rollback may remove the public routes entirely. Re-enabling caller-authored
settlement, authorization consumption, completion, or unsigned import requires
a superseding ADR and security approval; it is not an acceptable fallback.

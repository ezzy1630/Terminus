# ADR-0032: Phase 0 architecture freeze

- **Status:** ADOPTED
- **Date:** 2026-08-22
- **Decision owner:** release owner
- **Supersedes:** none
- **Related:** `Terminus — Research/roadmap.md` (Phase 0), SPEC §46, ADR-0002 (strangler), maturity.yaml, docs/security/findings-register.yaml

## Context

The roadmap's Phase 0 ("Truth, reproducibility and freeze") establishes a truthful baseline before any further architectural surface is added. The audit at research HEAD found semantic overclaiming: process-local state described as durable, stub adapters discoverable as capable, container enforcement reports exceeding the generated docker argv, hard-coded optimistic release metadata, README counts that drift from reality, and no CI run on the active branch. Adding features on top of unverified semantics compounds review debt and makes every later claim less trustworthy.

## Decision

Architecture-expanding feature work is frozen until the Phase 0 exit gate is met:

1. the exact default-branch HEAD has required green CI runs;
2. every failure and missing-infrastructure item is recorded (system card);
3. no source declaration contradicts release metadata (`just truth-check`);
4. baseline eval results and costs are signed (`just eval-baseline`);
5. every `durable` / `enforced` / `non-bypassable` / `production` claim maps to a test artifact.

During the freeze:

- **Allowed.** Truth work: CI corrections, evidence pipelines, conformance tests, honest reporting fixes (maturity registry, enforcement reports, adapter declarations), durability/security foundations from the roadmap's PR sequence, bug fixes, eval tasks.
- **Frozen.** New client surfaces, new provider adapters beyond contract stubs, new orchestration/context/memory capabilities, protocol additions without an adopted ADR, and any feature whose promotion would require an evaluation cohort that does not exist yet.

A component may not declare `production` in `maturity.yaml` without an `evidence` pointer to a reproducible artifact bound to HEAD; the codegen and truth-check gates enforce this mechanically.

## Alternatives

- **Continue feature work in parallel.** Rejected: it widens the gap between declarations and verified behavior, which is the root problem Phase 0 exists to close.
- **Hard rewrite before freeze.** Rejected by the strangler strategy (ADR-0002): the freeze protects the migration path; it does not replace it.

## Consequences

- Roadmap phases 1+ start from a reproducible, honestly classified baseline.
- Short-term feature velocity drops; the roadmap explicitly accepts this trade.
- The freeze is enforced socially by this ADR and mechanically by `truth-check`, `codegen-check`, and the release gate; lifting it requires amending this ADR with the exit-gate evidence attached.

## Security Impact

Positive. The freeze concentrates effort on the security-critical truths first: non-bypassability evidence, degraded-profile fail-closed behavior, secret-handling honesty, and supply-chain verification — all prerequisites for trusting anything built later.

## Evaluation Plan

- `just truth-check` green on every PR during the freeze.
- `just codegen-check` catches registry/inventory drift.
- CI runs required checks on the actual protected branches; missing runs block release decisions.

## Migration

None. The freeze applies immediately to ongoing planning: open work items are re-scoped against the allowed/frozen lists above.

## Rollback

Amend this ADR with release-owner + security-owner approval once the Phase 0 exit gate is signed; the registry/gates remain valuable afterwards and are retained permanently.

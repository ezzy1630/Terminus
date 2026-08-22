# ADR-0034: Transactional effect ledger and admission authority

- **Status:** ADOPTED
- **Date:** 2026-08-22
- **Decision owner:** runtime architecture owner
- **Supersedes:** none
- **Related:** `Terminus — Research/roadmap.md` (Phase 3), SPEC §3.2, §3.3, §7, §11, §12, §13, §14, §15, §16, §27, §28, ADR-0033 (durable task substrate)

## Context

In an autonomous or agent-driven operating system, mutations executed against real-world environments (filesystem changes, git commits/merges, process spawning, network calls, cloud provisioning) present critical safety hazards:
1. **Uncertainty & Retry Storms:** When an external effect times out or returns an ambiguous network response, naive retry risks duplicate irreversible mutations (e.g. charging a card twice, creating redundant branches).
2. **Confused Deputy & Replayable Approvals:** Approvals based on fuzzy operation matching or ambient tokens can be intercepted, replayed across tasks, or reused after replanning.
3. **Speculative Branch Contamination:** Parallel speculative candidate branches risk committing partial side-effects before winning admission review.
4. **Separation of Duty Violations:** Actors could approve their own changes without clean-context independent verification.

Phase 3 ("Transactional Effects and Authority") requires replacing uncoordinated tool calls with a formal **Transactional Effect Ledger**, semantic idempotency keys, durable single-use authorization instances, uncertainty reconciliation ("verify before retry"), object-capability resource handles, compiled sequence policy, and authoritative admission gates.

## Decision

Adopt the **Transactional Effect Ledger & Admission Authority** architecture across TypeScript control plane and Rust kernel layers:

1. **17-State Transactional Effect Ledger:**
   - Formal 17-state lifecycle: `PROPOSED` → `POLICY_CHECKED` → `AUTHORIZATION_REQUIRED` → `AUTHORIZED` → `PREPARED` → `DISPATCHED` → `OBSERVED` → `VALIDATED` → `COMMITTED`, with `UNCERTAIN`, `RECONCILING`, `COMPENSATING`, `COMPENSATED`, `RESIDUE`, `MANUAL_RECONCILE`, `DENIED`, and `CANCELLED`.
   - Transitions are strictly validated against `EFFECT_TRANSITIONS` and emit semantic events through the transactional outbox.

2. **Deterministic Semantic Idempotency Keys:**
   - Keys are derived via SHA-256 over `(taskId, intentType, effectClass, connectorOrWorker, canonicalParameters, resourceHandles)`.
   - Survives retries, agent replanning, control-plane failovers, and model changes, guaranteeing that identical intent resolves to the exact same ledger record.

3. **Durable Authorization Instances & Monotonic Single-Use:**
   - Replaces operation-hash scanning with named `AuthorizationInstance` records.
   - Bound monotonically to task ID, task contract version, effect class, max scope, and hash-bound approval text (`approvalHash`).
   - Atomically consumed upon effect preparation/dispatch; invalid upon task contract updates (replanning) or expiration.

4. **Verify-Before-Retry Uncertainty & Reconciliation Engine:**
   - Timeouts or network anomalies transition in-flight effects from `DISPATCHED` to `UNCERTAIN` → `RECONCILING`.
   - Connectors query remote state via read probes before any retry attempt:
     - Confirmed executed → `COMMITTED`.
     - Confirmed not executed → safe retry or `COMPENSATED`.
     - Ambiguous → `MANUAL_RECONCILE`.
   - Compensation handler manages `COMPENSATING` → `COMPENSATED` or `RESIDUE`.

5. **Attenuable Object-Capability Resource Handles:**
   - Typed handles `ResourceHandle` (`objectId`, `objectType`, `version`, `scope`, `allowedOperations`, `principalBinding`, `taskBinding`, `authorityEpoch`, `integrityHash`).
   - Attenuation can only narrow permissions; operations on stale versions throw `StaleHandleError`.

6. **Compiled Sequence Policy Engine:**
   - Enforces multi-step temporal invariants and separation of duty rules (e.g. `secret_scan_passed AND required_tests_passed AND reviewer != actor BEFORE branch.merge`).

7. **Admission Authority & Branch Isolation:**
   - The `AdmissionService` is the sole authoritative gatekeeper for merging speculative workspace candidate branches and committing external mutations.
   - Speculative candidate branches execute in isolated epochs; losing branches are fenced and cannot commit external effects.
   - Enforces `reviewerPrincipal !== actorPrincipal` on admission.

8. **Rust Kernel Integration:**
   - `KernelEffectLedger` in `crates/terminus-kernel` maintains an append-safe, reloadable effect ledger and authorization store with crash-resilient disk persistence.

## Alternatives Considered

- **Client-Generated Random UUID Idempotency Keys:** Rejected because a re-planned task or restarted agent generates a new random UUID, defeating duplicate prevention for the same semantic intent.
- **Ambient Reusable Approval Tokens:** Rejected because ambient tokens allow confused deputy bypasses and cross-task privilege escalation.
- **Eager Retries on Timeout without Read Probing:** Rejected because blind retries against external endpoints cause duplicate operations upon silent timeout successes.

## Consequences

- Full protection against duplicate side effects and phantom mutations during network partitions and worker crashes.
- Replay attacks, stale replanning reuse, and self-review approval bypasses are mechanically blocked.
- Speculative agent branches cannot leak side effects to production environments.
- 100% auditability for all external operations with verified claims and evidence.

## Security Impact

Extremely high positive impact. Establishes the non-bypassable transactional boundary around every external mutation in Terminus, eliminating split-brain effects and unauthorized escalation.

## Evaluation Plan

- 14-point effect fault matrix suite in `packages/task-runtime/src/effects.test.ts`.
- Rust kernel effect and authorization tests in `crates/terminus-kernel/src/ledger.rs`.
- Schema drift verification via `just codegen-check`.
- Full repository validation via `just check`, `just boundary-check`, `just check-all`.

# ADR-0033: Durable task substrate and transactional outbox

- **Status:** ADOPTED
- **Date:** 2026-08-22
- **Decision owner:** runtime architecture owner
- **Supersedes:** none
- **Related:** `Terminus — Research/roadmap.md` (Phase 2), SPEC §6, §7, §8, §10, §14, §28, §29, ADR-0005 (hybrid persistence), ADR-0032 (architecture freeze)

## Context

The audit of Terminus architecture highlighted that agent process lifecycles and control plane state were vulnerable to process restart and dual-write hazards:
1. State transitions, tool runs, and semantic event publishing occurred in uncoordinated steps, risking phantom mutations or lost audit events.
2. Worker execution lacked monotonic fencing tokens, creating split-brain risks when partitioned workers continued writing after lease expiration.
3. Questions, decisions, risks, and budget limits were stored ephemerally without strict budget enforcement or durable audit trails.
4. Process managers, capability tokens, and approval records in the Rust kernel did not persist state across restarts, breaking idempotency and recovery guarantees.

Phase 2 ("Durable Task Substrate") requires eliminating all uncoordinated in-memory authoritative state in favor of durable event-sourced state machines, transactional outbox/inbox deduplication, worker leases with fencing epochs, and deterministic crash recovery drills.

## Decision

Adopt the **Durable Task Substrate** architecture across TypeScript control plane and Rust kernel layers:

1. **State Machine State Engines:**
   - Formal state machines and transition matrices for `TaskV2`, `Workflow`, `NodeRun`, `WorkerLease`, and `TaskAttempt`.
   - Immutable versioning on `TaskContractV2` and optimistic concurrency control (`expectedVersion`) on task updates.
   - Directed Acyclic Graph (DAG) validation on workflow definitions using Kahn's algorithm before compilation.

2. **Transactional Outbox & Inbox:**
   - Every aggregate mutation creates a corresponding `OutboxMessage` persisted in the same transaction. Events are relayed asynchronously to subscribers with delivery tracking (`markOutboxDelivered`).
   - Every mutating command is filtered through a `TransactionalInbox` keyed by SHA-256 payload hash and idempotency key, preventing dual execution and race conditions.

3. **Worker Leases & Fencing Tokens:**
   - Active worker execution requires a `WorkerLease` with monotonic fencing tokens.
   - Stale worker mutations presented after lease expiration or fencing epoch bumps are rejected with `FencingError` / `LeaseError`.

4. **Durable Decisions, Risks & Budgets:**
   - Structured human/model question workflows (`Question`), architectural decisions (`Decision`), and risk tracking (`Risk`) with mitigation states.
   - Strictly enforced budget constraints (`costMicros`, `computeSeconds`, token counts) with hard-failure on exhaustion (`BudgetExhaustedError`, emitting `budget.exhausted`).

5. **Rust Kernel Durable Backing:**
   - `JobManager` in `crates/terminus-jobs` persists job records and reconciles orphaned processes upon restart.
   - `ApprovalStore` in `crates/terminus-kernel` persists single-use approval consumptions and operation hashes.
   - `RevocationList` in `crates/terminus-authz` persists revoked capability token IDs and epoch invalidations.

6. **Deterministic Event Replay Recovery:**
   - `DurableTaskSubstrate` and `InMemoryDurableTaskRepository` rebuild all active tasks, leases, attempts, decisions, and budgets from the append-only `semantic_events` log upon startup.

## Alternatives Considered

- **Synchronous Direct Dual-Writes:** Rejected because network or process failures during the second write leave state and events permanently out of sync.
- **Pure Event Sourcing without Materialized Aggregates:** Rejected due to performance degradation over long-running tasks and complex query requirements; hybrid CQRS with outbox/inbox strikes the optimal balance for Terminus.
- **Distributed Locking without Fencing Tokens:** Rejected because distributed locks without monotonic tokens cannot guard against delayed in-flight requests from partitioned workers (the Martin Kleppmann fencing token theorem).

## Consequences

- Zero dual-write bugs between state mutations and SSE event streams.
- Crash resilience: any service restart reconstructs consistent aggregate state from the durable event log.
- Clean isolation of stale or partitioned workers via fencing tokens.
- Strict mechanical budgeting prevents runaway model inference cost.

## Security Impact

Positive. Approvals and capability token revocations survive kernel restarts. Replayed or altered operations cannot bypass single-use approval limits, and revoked tokens remain permanently blocked.

## Evaluation Plan

- `packages/task-runtime/src/substrate.test.ts` validates outbox atomic delivery, inbox deduplication, lease fencing rejection, workflow DAG execution, and crash recovery.
- Kernel integration and crash recovery tests in `crates/terminus-kernel/tests/` verify persistent approval and revocation reload.
- Full verification via `just check`, `just boundary-check`, `just codegen-check`, and `just unit`.

# @terminus/task-runtime

Task lifecycle: `TaskService` with `createTask`, `activate`, `updateContract`
(versioned), `transition` (state machine per Appendix C — DRAFT→ACTIVE→...
→COMPLETED), `addAcceptanceCriterion`, `compileScopeLedger`,
`recordScopeEntry`, `enforceScope`.

Per SPEC §28.3, §37.1, §37.3. Uses a `TaskRepository` interface (no direct
Prisma import). Persists semantic events via an `EventSink`.

## Public API

- `TaskService` class with methods listed above.
- `TaskRepository` interface for persistence.
- `SqliteDurableTaskRepository` with an injected `SqliteDatabasePort` for
  durable SQLite state, atomic state-plus-outbox writes, inbox claims, CAS,
  and persisted sequence/epoch counters.
- `globMatch(pattern, path)` for scope-glob matching.
- State machine helpers: `ALLOWED_TASK_TRANSITIONS`,
  `TASK_TERMINAL_STATES`, `isTaskTransitionAllowed`, `isTaskTerminal`.

## Invariants

- The task state machine (§28.3) is enforced; invalid transitions throw
  `StateTransitionError`.
- Contract version MUST increase on every update.
- `enforceScope` rejects effects outside the allowed scope ledger.

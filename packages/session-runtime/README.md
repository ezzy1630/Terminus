# @terminus/session-runtime

Session/thread/turn lifecycle: `SessionService` with `openWorkspace`,
`createSession`, `pause`, `archive`. `ThreadService` with `create`, `fork`,
`listTurns`. `TurnService` with `start`, `transition` (state machine
PENDING→CONTEXT_COMPILING→PROVIDER_RUNNING→RESPONSE_VALIDATING→TOOL_SETTLEMENT→FINALIZING→COMPLETED),
`interrupt`, `resume`.

Per SPEC §28.4. Uses a `SessionRepository` interface (no direct Prisma).

## Public API

- `SessionService`, `ThreadService`, `TurnService` classes.
- `SessionRepository` interface.
- `TURN_STATE_TRANSITIONS`, `isTurnTransitionAllowed`.

## Invariants

- Turn transitions are enforced; invalid transitions throw
  `StateTransitionError`.
- `resume` is only valid from `INTERRUPTED`.
- Sequence numbers are monotonic per thread.

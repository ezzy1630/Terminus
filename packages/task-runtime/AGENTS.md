# @terminus/task-runtime — local rules

## Non-negotiable

- No direct Prisma import; use `TaskRepository`.
- Contract version MUST increase on every update.
- State machine transitions enforced; terminal states are absorbing.
- `enforceScope` is the authoritative scope check for write/read effects.

## Style

- Every state change emits a semantic event.
- Use `globMatch` for scope-glob checks — no inline regex.
- Throw `StateTransitionError` or `ScopeViolationError`, never raw `Error`.

## What NOT to add

- Direct filesystem or process access.
- Provider calls.

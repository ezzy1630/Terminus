# @terminus/runtime-protocol — local rules

## Non-negotiable

- Every event type MUST be in the closed `EVENT_TYPES` list.
- Every payload MUST have a zod schema.
- Never emit raw `Error` strings as event payloads; use `ForgeError` envelopes.
- Events are immutable. Never mutate an already-emitted event.

## Style

- Use `as const` for `EVENT_TYPES` and `AGGREGATE_TYPES`.
- Use `assertNever` on exhaustiveness checks over `EventType`.
- SSE encoding MUST set `id:` lines for cursor resume.

## What NOT to add

- I/O. The sink is an interface; concrete persistence lives in
  `@terminus/task-runtime`/`@terminus/session-runtime`.
- Provider-specific shapes.
- Direct persistence layer.

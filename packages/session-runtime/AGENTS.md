# @forge/session-runtime — local rules

## Non-negotiable

- No direct Prisma import; use `SessionRepository`.
- Turn state machine (§28.4) enforced.
- `resume` is only valid from `INTERRUPTED`.
- Sequence numbers are monotonic per thread.

## What NOT to add

- Direct provider calls.
- Filesystem/process access.

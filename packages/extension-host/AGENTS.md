# @terminus/extension-host — local rules

## Non-negotiable

- Hooks receive immutable event views.
- Hook ordering is deterministic (priority, then extension ID).
- Lifecycle scripts are denied by default.
- `verified_third_party` extensions require a signature.
- Veto halts further hook execution.

## What NOT to add

- Direct in-process execution of third-party code.
- Filesystem or network access from extensions (the kernel owns isolation).

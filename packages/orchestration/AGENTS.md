# @terminus/orchestration — local rules

## Non-negotiable

- The scheduler is deterministic in v1.
- Parallel writing is exceptional and gated by positive expected value.
- Loop intervention MUST prefer bounded failure over token burn.
- The reviewer cannot edit in the same run.

## What NOT to add

- Direct worktree mutation (the kernel owns git/patch).
- Provider calls.

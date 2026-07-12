# @forge/cli — Non-Interactive CLI

The **non-interactive client** for CI and automation (SPEC §42.1). Speaks JSON
to stdout; errors to stderr; exit codes 0=ok, 1=error, 2=usage, 3=timeout.

Per SPEC §32.3: starting a task returns immediately with an event cursor;
clients subscribe to events. Long-running HTTP requests MUST NOT own durable
execution.

## Usage

```bash
# Health
bun apps/cli/src/index.ts health

# Create a workspace + session + task + turn, then wait for completion
W=$(bun apps/cli/src/index.ts new-workspace --root /tmp/forge-demo | jq -r .id)
S=$(bun apps/cli/src/index.ts new-session --workspace $W --title "ci" | jq -r .id)
T=$(bun apps/cli/src/index.ts new-task \
  --session $S --thread $(... active_thread_id ...) --objective "fix the bug" \
  | jq -r .id)
bun apps/cli/src/index.ts start-task $T
bun apps/cli/src/index.ts start-turn --thread $TID --task $T --input "fix it"
bun apps/cli/src/index.ts wait $T --timeout 300

# Stream SSE events as JSONL
bun apps/cli/src/index.ts events --task $T

# Resolve an approval from CI
bun apps/cli/src/index.ts resolve-approval <id> --decision allow_once --rationale "ci-approved"
```

## Commands

`health`, `sessions`, `session <id>`, `tasks <session-id>`, `task <id>`,
`new-workspace`, `new-session`, `new-task`, `start-task <id>`,
`cancel-task <id>`, `start-turn`, `wait <task-id>`, `events`, `manifest <id>`,
`artifact <hash>`, `approvals`, `resolve-approval <id>`, `evals`, `config`.

Run `bun apps/cli/src/index.ts help` for the full list.

## Environment

- `FORGE_GATEWAY` — Gateway base URL (default: `http://127.0.0.1:81`)
- `FORGE_TOKEN` — Bearer token

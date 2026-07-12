# @forge/tui — Terminal Client

The **primary client surface** for Forge (SPEC §43.4). Connects to the public
API via the Caddy gateway, subscribes to the SSE event stream, and renders a
live view of sessions, tasks, turns, approvals, and events in the terminal.

Per SPEC §32.5: clients reconnect by authenticating, fetching the task/session
snapshot, resuming events from the last durable cursor, reconciling pending
local UI actions by idempotency key, rendering active approvals and jobs, and
attaching to desired streams.

## Usage

```bash
# System + kernel health
bun apps/tui/src/index.ts health

# List sessions
bun apps/tui/src/index.ts sessions

# List tasks in a session
bun apps/tui/src/index.ts tasks <session-id>

# Subscribe to the live SSE event stream (all events, or filtered to a task)
bun apps/tui/src/index.ts events [task-id]

# Create a workspace + session + task + turn interactively
bun apps/tui/src/index.ts new
```

## Environment

- `FORGE_GATEWAY` — Gateway base URL (default: `http://127.0.0.1:81`)

## Status

Scaffold. A full TUI with curses-style rendering, interactive approval prompts,
context manifest inspection, and patch preview is the next milestone.

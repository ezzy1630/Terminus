# Terminus terminal client

The primary Terminus client described by SPEC §43.4. It is a full-screen,
keyboard-first terminal UI over `@terminus/public-client`. The client owns no
filesystem, process, secret, or network authority beyond the public API calls
authorized by the configured bearer token.

## Start it

With the local control plane already running:

```bash
TERMINUS_TOKEN="$TERMINUS_CONTROL_TOKEN" just run-tui
```

To start the local kernel, control plane, and TUI together in development mode:

```bash
just run
```

`just run` uses the documented local development token only while
`TERMINUS_DEV=1`. `just run-tui` does not invent a token. It fails before the
first request when `TERMINUS_TOKEN` is missing.

## Interface

The default desktop layout keeps the transcript central:

- Sessions and tasks on the left.
- User messages, agent responses, tool activity, and the prompt in the center.
- Optional task details, attention, connection, and inspected context on the right.

Press `b` to hide the sidebar and `d` to show or hide task details. Both panes
collapse when the terminal cannot fit them. The transcript and prompt remain
usable in narrow terminals.

Keyboard controls:

```text
Tab / Shift+Tab   Move focus
Up / Down         Move the selected row
Enter             Open a row or send the prompt
Left / Right      Move the prompt cursor
Home / End        Jump within the prompt
Up / Down         Browse prompt history or command suggestions
Tab               Complete a suggested slash command
n                 Create and start a task
a                 Review the next exact-effect approval
x                 Answer the next material question
i                 Inspect the selected event payload
r                 Refresh server snapshots
b / d             Toggle sidebar / task details
/                 Type a command with inline suggestions
Ctrl+P            Open the command palette
?                 Show all controls
Ctrl+Q             Quit
```

Mouse clicks select sessions, tasks, the activity list, and the prompt. The
wheel scrolls retained activity.

The command palette supports task pause, resume, detached review, controlled
task cancellation, context-manifest inspection, immutable artifact and diff
preview, job inspection, and controlled job stop. Consequential stop commands
require a second confirmation.

## Continuity

The TUI authenticates, reloads server snapshots, renders active approvals and
questions, and attaches to the selected task's SSE stream. It retains the last
durable cursor, deduplicates replayed event IDs, and reconnects with capped
backoff. Changing tasks cancels the previous stream before attaching to the new
one.

The visible activity list retains 500 events. This is a client display limit,
not data loss: the durable cursor remains server-owned. Artifact previews stop
at 64 KiB and show the exact byte count and immutable hash when truncated.

## Scriptable commands

The non-interactive commands remain available for scripts and diagnostics:

```bash
bun apps/tui/src/index.ts health
bun apps/tui/src/index.ts sessions
bun apps/tui/src/index.ts tasks <session-id>
bun apps/tui/src/index.ts events [task-id]
bun apps/tui/src/index.ts new
bun apps/tui/src/index.ts orgs
bun apps/tui/src/index.ts cockpit <task-id>
bun apps/tui/src/index.ts attention [task-id]
```

Environment:

- `TERMINUS_GATEWAY`: public gateway or control-plane URL. `just run-tui`
  defaults to `http://127.0.0.1:3050`.
- `TERMINUS_TOKEN`: required non-empty local authentication token.

## Checks

```bash
bun run --cwd apps/tui typecheck
bun run --cwd apps/tui lint
bun run --cwd apps/tui test
```

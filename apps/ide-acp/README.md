# @terminus/ide-acp — IDE/ACP Adapter

The **ACP (Agent Client Protocol) adapter** for editor integration (SPEC §42.1,
§32.6). Speaks ACP-over-stdio JSON-RPC on stdin/stdout; translates to Terminus
public API calls. The adapter is NOT privileged — it calls the public API and
receives no direct filesystem authority.

Per SPEC §32.6, the ACP adapter maps:
- editor workspace and selection → explicit context directives
- diagnostics and open files → world-state contributions
- plans and progress → ACP updates
- approval prompts → editor-native interactions
- patches → preview/apply flows
- task/session identifiers → resume metadata

## Usage

Configure your editor's ACP client to launch:

```bash
bun apps/ide-acp/src/index.ts
```

Environment:
- `TERMINUS_GATEWAY` — Gateway base URL (default: `http://127.0.0.1:81`)

## Methods (JSON-RPC)

- `initialize` — capability negotiation
- `shutdown`
- `terminus/health` — system + kernel health
- `terminus/sessions` — list sessions
- `terminus/createTask` — create workspace + session + task + start
- `terminus/startTurn` — begin a turn (triggers the agent loop)
- `terminus/approvals` — list pending approvals
- `terminus/resolveApproval` — allow/deny an approval
- `terminus/manifest` — get a context manifest

## Status

Scaffold. A full ACP implementation with editor-native approval prompts, patch
preview, and diagnostics push is the next milestone.

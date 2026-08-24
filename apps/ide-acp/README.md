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
- `TERMINUS_TOKEN` — Required non-empty local authentication token for every
  method that calls the Terminus API. The adapter has no built-in token
  fallback.

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
- `terminus/v2/contextSync` — validate and synchronize editor context
- `terminus/v2/intervene` — propose a typed structured intervention
- `terminus/v2/attentionAssess` — inspect task attention state
- `terminus/v2/questions` — list material questions
- `terminus/v2/resolveQuestion` — resolve one material question
- `terminus/v2/replay` — get the task's causal trace

Mutating JSON-RPC requests require either a request `id` or an explicit
`idempotencyKey`; the adapter derives stable per-step HTTP idempotency keys from
that identity.

## Status

Experimental ACP-over-stdio bridge. Request parsing, authenticated public-client
calls, context synchronization, material-attention reads, and structured
intervention proposal exist locally. Editor-host conformance, editor-native
approval prompts, patch preview, diagnostics push, reconnection, and
cross-surface continuity remain unverified; this adapter does not satisfy the
Phase 9 roadmap exit gate.

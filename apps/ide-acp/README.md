# @terminus/ide-acp — Terminus JSON-RPC IDE Bridge

This is a custom JSON-RPC-over-stdio bridge for editor integration (SPEC §42.1,
§32.6). It translates Terminus-specific methods to public API calls. It is not
an implementation of ACP v1, so standard ACP clients must not be configured as
if this were an ACP server. The bridge is NOT privileged — it calls the public
API and receives no direct filesystem authority.

Per SPEC §32.6, the bridge maps:
- editor workspace and selection → explicit context directives
- diagnostics and open files → world-state contributions
- plans and progress → Terminus-specific JSON-RPC results
- approval prompts → editor-native interactions
- patches → preview/apply flows
- task/session identifiers → resume metadata

## Usage

Configure a custom editor bridge to launch:

```bash
bun apps/ide-acp/src/index.ts
```

Environment:

- `TERMINUS_GATEWAY` — Gateway base URL (default: `http://127.0.0.1:81`)
- `TERMINUS_TOKEN` — Required non-empty local authentication token for every
  method that calls the Terminus API. The adapter has no built-in token
  fallback. Inject it from the local secret manager or parent process; do not
  put a raw token in generated editor settings.

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

Experimental Terminus JSON-RPC bridge. Request parsing, authenticated
public-client calls, context synchronization, material-attention reads, and
structured intervention proposal exist locally. ACP v1 compatibility,
editor-host conformance, editor-native approval prompts, patch preview,
diagnostics push, reconnection, and cross-surface continuity remain
unverified; this bridge does not satisfy the Phase 9 roadmap exit gate.

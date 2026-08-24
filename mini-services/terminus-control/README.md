# terminus-control mini-service

The **TypeScript control plane** for Terminus (SPEC §5, §27, §32). Owns cognition
and product state — sessions, tasks, context compiler, providers,
orchestration, verification, memory, public API. Has NO ambient effect
authority; every privileged operation crosses the Rust kernel boundary via
the authenticated `terminus.kernel.v1` gRPC API over a private Unix-domain
socket.

## Run

```bash
cd /home/z/my-project
bun mini-services/terminus-control/src/index.ts
```

Or use the start script:

```bash
bash scripts/start-mini-services.sh
```

The service listens on port 3050.

## Architecture

```
Next.js UI (port 3000)
    │ HTTP/SSE via Caddy gateway (?XTransformPort=3050)
    ▼
terminus-control (port 3050, this service)
    │ privileged effects RPC (gRPC over private UDS)
    ▼
terminus-kernel (Rust)
```

## Endpoints (30+ resource groups)

Per SPEC §32.1, exposes all resource groups:
`/system /workspaces /sessions /threads /tasks /turns /events /context
/artifacts /tools /jobs /approvals /agents /verification /memory /evals
/configuration`.

## Event stream

`GET /v1/events?cursor=<last-event-id>&task_id=<optional>` returns an SSE
stream of semantic events (SPEC §30.6). Events are persisted to the
`semantic_events` SQLite table before delivery, so clients can resume from
the last durable cursor.

## Agent loop

On `POST /v1/turns`, the service compiles and persists the exact provider
request, then stops at `PROVIDER_RUNNING` unless a durable local provider
command is configured. The default local service has no transport: it marks
the attempt and turn failed and leaves the task `BLOCKED` with
`provider_transport_unavailable`. It never invents a model response or
verification result.

Provider settings are credential-free, revision-checked, and executed as exact
argv through the kernel. Tool use is an explicit opt-in. The standalone tool
profile contains only `read`, exact-text `patch`, and bounded `exec`; it accepts
one call per response and four calls per turn. Each call is validated against
the task contract, recorded before dispatch, settled through the kernel, and
persisted as a complete model-visible call/result pair. The next provider
attempt recompiles a new exact manifest from those artifact bytes. Ambiguous
write or exec settlement blocks the task for manual review instead of retrying.

The remaining lifecycle is
`RESPONSE_VALIDATING → TOOL_SETTLEMENT → (CONTEXT_COMPILING → PROVIDER_RUNNING)*
→ FINALIZING → COMPLETED`, followed by the independent task verification and
completion-admission path. Every state change emits a semantic event visible to
clients.

## Persistence

Uses Prisma (SQLite) for all operational state. The schema is in
`prisma/schema.prisma` at the project root.

Checkpoint content is server-derived from persisted task state, canonically
encoded, ingested through the kernel, and linked to its checkpoint owner before
the database row is published. Resume re-fetches the artifact and verifies its
URI, SHA-256, strict schema, canonical bytes, task contract, and known source
versions before it can enter context.

The kernel persists its workspace registry and resolves every file operation
through the root bound to `WorkspacePath.workspace_id`. Capability tokens are
workspace-bound (except for the explicit development-only wildcard token), so
registered roots cannot be crossed by changing a relative path or workspace ID.

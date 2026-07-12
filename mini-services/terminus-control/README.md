# terminus-control mini-service

The **TypeScript control plane** for Terminus (SPEC §5, §27, §32). Owns cognition
and product state — sessions, tasks, context compiler, providers,
orchestration, verification, memory, public API. Has NO ambient effect
authority; every privileged operation crosses the Rust kernel boundary via
`http://127.0.0.1:3040`.

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
    │ privileged effects RPC (http://127.0.0.1:3040)
    ▼
terminus-kernel (port 3040, Rust)
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

On `POST /v1/turns`, the service runs the full agent loop end-to-end:
`PENDING → CONTEXT_COMPILING → PROVIDER_RUNNING → RESPONSE_VALIDATING →
TOOL_SETTLEMENT → FINALIZING → COMPLETED`. If the parent task is ACTIVE, it
advances through `VERIFYING → COMPLETED` with a verification DAG (parse →
diagnostics → narrow_tests). Every step emits semantic events visible in the
UI.

## Persistence

Uses Prisma (SQLite) for all operational state. The schema is in
`prisma/schema.prisma` at the project root.

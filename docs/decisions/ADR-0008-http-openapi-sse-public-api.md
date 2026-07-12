# ADR-0008: HTTP/OpenAPI + SSE public API

- **Status:** PROVISIONAL
- **Date:** 2025-07-11
- **Decision owner:** protocol owner
- **Supersedes:** none
- **Related:** SPEC §7.1, ADR-0029

## Context

The public product API serves TUI, CLI, web, desktop, IDE/ACP, SDK, and CI clients. It must support streaming (for task/turn/tool events), pagination, idempotency, typed errors, and versioning. OpenCode-compatible HTTP/OpenAPI must be retained during bootstrap (ADR-0002).

Clients must be stateless enough to reconnect from server snapshots and event cursors (SPEC §43.4). The API must not provide a "generic execute arbitrary code" endpoint at this boundary (SPEC §44.7).

## Decision

Adopt **HTTP/OpenAPI + SSE** for the public product API per SPEC §7.1:

- **Transport:** HTTPS (or HTTP on localhost for development). SSE for server-to-client streaming of task/turn/tool/policy events. Optional WebSocket is OPEN (ADR-0029).
- **Schema:** OpenAPI 3.1 generated from TypeScript runtime schemas in `packages/public-api`. Generated TS/Rust/Python clients in `packages/public-client`.
- **Pagination:** Opaque cursors (SPEC §44.7).
- **Idempotency:** Mutating operations accept `Idempotency-Key` header.
- **Errors:** Typed errors with stable codes (SPEC §44.5).
- **Versioning:** URL-prefixed (`/v1/...`) or header versioning, defined before release.
- **Streaming:** SSE with `Last-Event-ID` for resume. Events carry opaque cursors; clients reconnect with the cursor to continue.
- **No generic execute:** No "POST /execute" with arbitrary code; all operations are noun/resource-oriented (SPEC §44.7).

Status is PROVISIONAL because WebSocket (ADR-0029) may eventually complement or replace SSE for bidirectional cases. The OpenAPI schema is stable; the transport binding may be amended.

## Alternatives

- **gRPC for the public API.** Rejected: poorer browser/IDE story; harder OpenAPI generation; OpenCode compatibility lost.
- **WebSocket only.** Rejected (OPEN in ADR-0029): more complex reconnection; SSE is simpler for the dominant one-way streaming case.
- **GraphQL.** Rejected: harder to generate multi-language clients; complicates idempotency and pagination; no clear benefit over REST+SSE for our resource model.

## Consequences

- The `packages/public-api` package owns the OpenAPI source; `packages/public-client` owns generated clients.
- SSE consumers read via opaque cursors; duplicate detection is server-side.
- The Caddy gateway exposes the public API on port 3000 (or via `?XTransformPort=` for mini-services).
- Contract tests run current client × current API and previous client × current API (SPEC §46.6).

## Security Impact

Medium. HTTPS enforces transport security. Idempotency keys prevent duplicate effects on retry (SPEC §26.3 #9). Typed errors prevent information leakage (SPEC §44.5). No generic execute endpoint prevents the model from synthesizing arbitrary privileged calls through the public API.

## Evaluation Plan

- OpenAPI compatibility tests run in CI.
- SSE reconnect/duplicate tests verify cursor-based resume (SPEC §46.7).
- Idempotency tests verify duplicate requests return equivalent results.
- Client SDK tests verify generated clients round-trip all operations.

## Migration

OpenCode-compatible HTTP/OpenAPI is retained during bootstrap (ADR-0002). The Terminus public API is layered above it; the OpenCode facade is removed once all clients migrate (M11+).

## Rollback

If SSE proves insufficient for bidirectional cases, add WebSocket (ADR-0029) as a complement. The OpenAPI schema remains stable; only the transport is extended. Do not silently break the SSE contract.

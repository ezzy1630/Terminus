# ADR-0029: Public WebSocket transport

- **Status:** OPEN
- **Date:** 2025-07-11
- **Decision owner:** protocol owner
- **Supersedes:** none
- **Related:** SPEC §7.1, ADR-0008, §49.5

## Context

The public API (ADR-0008) uses HTTP/OpenAPI + SSE by default. SSE is server-to-client only; client-to-server is a separate HTTP POST. For most operations (task creation, approval, tool invocation) this is fine. But for some use cases — interactive approvals, real-time tool input streaming, low-latency bidirectional events — a single bidirectional WebSocket connection would be simpler and lower-latency than SSE+POST.

SPEC §49.5 lists "WebSocket public transport" as deliberately experimental. SSE is sufficient for the first production release. WebSocket may be added as a complement or replacement once its value is demonstrated.

## Decision (OPEN)

This ADR is OPEN. The experiment owner is the protocol owner. The decision will be made after the public API (ADR-0008) is stable and there is evidence that SSE+POST is insufficient for a real use case.

Candidate designs under evaluation:

1. **WebSocket as complement to SSE** — SSE for server-to-client events; WebSocket for bidirectional cases (interactive approvals, tool input). Two transports, same events.
2. **WebSocket as replacement for SSE** — single bidirectional transport. Simpler client; loses SSE's HTTP/2 streaming benefits.
3. **WebSocket with subprotocols** — `terminus.v1.events` and `terminus.v1.rpc` subprotocols on the same connection.
4. **No WebSocket** — SSE+POST only. The baseline.

Selection criteria:
- Latency for bidirectional cases (measured).
- Client complexity (SSE+POST vs. WebSocket).
- Reconnection semantics (SSE has `Last-Event-ID`; WebSocket needs custom).
- HTTP/2 vs. HTTP/1.1 behavior.
- Browser/IDE compatibility.
- Promotion gate per ADR-0025.

The WebSocket transport, if chosen, would be a complement (not a replacement) until its gate passes.

## Alternatives

- **WebSocket only (no SSE).** Rejected for now: SSE is simpler for the dominant one-way streaming case; WebSocket reconnection is more complex.
- **WebSocket on by default.** Rejected (SPEC §49.5): unproven; SSE is sufficient.
- **No research.** Rejected: WebSocket may genuinely help interactive use cases; should be evaluated.

## Consequences (once a design is chosen)

- The public API supports both SSE and WebSocket (or just WebSocket, if it replaces SSE).
- Generated clients support both transports.
- Reconnection semantics are well-defined for both.
- Contract tests run for both transports.

## Security Impact

Low. WebSocket over HTTPS (WSS) is as secure as HTTPS+SSE. Authentication, idempotency, and typed errors apply equally. No generic execute endpoint (SPEC §44.7) regardless of transport.

## Evaluation Plan

- Latency benchmarks: SSE+POST vs. WebSocket for interactive approvals and tool input.
- Client complexity: lines of code, dependencies.
- Reconnection tests: both transports recover from disconnect.
- Browser/IDE compatibility tests.
- Promotion gate per ADR-0025.

## Migration

WebSocket, if chosen, is introduced after the public API (ADR-0008) is stable. It is a complement (not a replacement) until its gate passes.

## Rollback

If WebSocket causes regression (complexity, bugs, performance), disable it (fall back to SSE+POST). The SSE contract (ADR-0008) remains stable. Do not silently remove SSE — clients depend on it.

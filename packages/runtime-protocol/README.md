# @terminus/runtime-protocol

Defines the Agent Runtime Protocol (ARP): the typed semantic-event union,
envelope shape, emitter/observer interfaces, and SSE encoder/decoder.

Per SPEC §28.9 every semantic audit event carries an immutable envelope with
`event_id`, `event_type`, `schema_version`, `aggregate_type`, `aggregate_id`,
`aggregate_sequence`, `occurred_at`, `actor`, `correlation_id`,
`causation_id`, `idempotency_key`, `payload`, `artifact_refs`, `trace_id`.

## Public API

- `EVENT_TYPES`: the closed list of event types (task.*, turn.*, tool.*,
  policy.*, approval.*, effect.*, context.*, checkpoint.*, agent.*,
  verification.*, memory.*, capability.*).
- `EventPayloadMap`: maps each event type to its strongly-typed payload.
- `TypedEvent<T>`, `AnyTypedEvent`, `EventEnvelope`.
- `EventSink` (emitter) and `EventObserver` interfaces.
- `encodeSseEvent` / `decodeSseFrame` / `splitSseStream` for SSE streaming.
- `payloadSchemaFor(type)` for runtime validation of payloads.

## Dependencies

`@terminus/domain`, `zod`.

## Invariants

- Events are immutable. Corrections are new events.
- High-volume byte streams (PTY output) MUST NOT be stored as individual
  semantic events — they belong in artifacts or chunk records.
- The SSE wire format MUST include `id:` so clients can resume with
  `Last-Event-ID`.

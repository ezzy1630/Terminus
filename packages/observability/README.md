# @forge/observability

OpenTelemetry-style span helpers, structured logging, and metric definitions.
Privacy-aware: never logs raw prompts, source, secrets; uses IDs and hashes.

The package exposes minimal `TelemetryBackend`, `Logger`, and span/metric
interfaces. The default backend is in-memory and suitable for tests; production
deployments install a real backend via `setTelemetryBackend`.

## Public API

- `startSpan(name, attributes?, parent?, resource?)` returns a `Span`.
- `recordError(span, err)` annotates a span with error attributes.
- `metric(name, value, tags?, type?, unit?)`, `counter`, `gauge`, `histogram`.
- `logger(resource?)` returns a `Logger`; `.with(...)`, `.span(...)`,
  `.event(...)` derive child loggers.
- `Metrics`: standard metric names.
- `redact`, `redactFields`: privacy-aware value scrubbing.
- `setTelemetryBackend(b)` and `setDefaultResource(r)`.

## Invariants

- Logs MUST NOT contain raw prompts, source, credentials, or full tool output.
- Field keys matching `secret|password|token|key|credential|authorization` are
  auto-redacted.
- Slow clients MUST NOT block the kernel; critical events persist before
  delivery.

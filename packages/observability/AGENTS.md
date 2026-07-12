# @terminus/observability — local rules

## Non-negotiable

- Never log raw prompts, source code, credentials, or full tool output.
- Always redact fields with secret-looking names.
- Span/log/metric emission MUST be non-blocking; if a backend is unavailable
  drop telemetry with a counter rather than throwing.

## Style

- Use `Metrics` constants for metric names — no inline strings.
- Always pair `startSpan` with `end` (use try/finally).
- Pass `ResourceContext` so logs can be filtered by service/component/session.

## What NOT to add

- Direct OTLP/HTTP export. Backend implementations are pluggable.
- Logging of model-visible strings outside the manifest/artifact path.
- File or network I/O in this package.

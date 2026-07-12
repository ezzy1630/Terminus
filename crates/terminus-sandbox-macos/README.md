# terminus-sandbox-macos

Platform sandbox backend stub for Terminus.

This crate provides a `SandboxBackend` implementation that honestly reports
its effective enforcement. The in-sandbox build does not link the platform's
native sandboxing primitives (bubblewrap on Linux, Seatbelt on macOS,
AppContainer on Windows, OCI runtime for containers), so each backend reports
`Unsupported` or `Degraded` and fails closed when asked to support a
profile it cannot enforce. See SPEC.md Section 13.4.

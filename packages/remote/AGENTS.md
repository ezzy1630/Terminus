# @terminus/remote

Single-tenant remote deployment contracts (SPEC §48.14).

## Rules

- No network I/O. Transport bridges live in control/kernel services.
- Mutable image tags are forbidden.
- Disconnect must never turn `STARTED` into `SETTLED`.
- Multi-tenant shared kernel is out of scope (ADR-0030).

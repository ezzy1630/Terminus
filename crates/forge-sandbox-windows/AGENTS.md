# AGENTS.md — forge-sandbox-windows

## Local rules

- **Honest reporting.** Populate `enforcement_report()` accurately. The
  in-sandbox build MUST NOT claim namespace isolation it does not have.
- **Fail closed.** When the platform primitive is unavailable, return
  `Err(SandboxError::Unsupported(...))` from `supports_profile`.
- **No `unsafe`** in the stub build. Linking platform primitives is a
  future task and will require an ADR.
- **No panics.**

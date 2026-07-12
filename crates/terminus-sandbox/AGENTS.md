# AGENTS.md — forge-sandbox

## Local rules

- **Honest reporting.** Every backend MUST populate `enforcement_report()`
  accurately. Silently downgrading is forbidden (SPEC.md Section 13.4).
- **Fail closed.** If a backend cannot enforce a profile, it MUST return
  `Err(SandboxError::Unsupported(...))` from `supports_profile`. The manager
  then tries the next fallback. If none succeed, the request fails closed.
- **No ambient secrets.** Backends MUST reject profiles with
  `SecretsAccess::AmbientEnvironment`.
- **No namespace magic in the default backend.** `LocalRestrictiveBackend`
  is intentionally process-group + env + cwd-jail only. Full namespace
  isolation lives in `forge-sandbox-linux`.
- **No `unsafe`.**
- **No panics.**

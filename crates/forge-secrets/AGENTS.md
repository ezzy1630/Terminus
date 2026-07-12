# AGENTS.md — forge-secrets

## Local rules

- **Never serialize the raw secret value.** `SecretHandle::value` is private
  to the crate. `Debug` prints `<redacted>`. Audit entries hold metadata
  only.
- **Short-lived.** Each `SecretHandle` carries an `expires_at_unix`. The
  broker MUST refuse to mint handles past their provider's expiry.
- **Best-effort wipe on drop.** `SecretHandle::drop` MUST zero the in-memory
  bytes. (We cannot guarantee the compiler has not copied them; the real
  guarantee comes from never logging them.)
- **One process.** A handle is bound to one process. The kernel MUST NOT
  share handles across processes.
- **Redaction is mandatory.** Every output stream from a process that
  received a secret MUST pass through `Redactor` before being persisted.
- **No `unsafe`.** No panics.

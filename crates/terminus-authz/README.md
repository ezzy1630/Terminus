# terminus-authz

HMAC-signed short-lived capability tokens for the Terminus kernel.

`TokenIssuer` mints `CapabilityToken`s bound to a principal, session, task,
workspace, kernel instance, operation classes, and maximum scope. Tokens are
HMAC-SHA256 signed over the canonical JSON of their claims and may be revoked
through an in-memory `RevocationList` (production deployments back this with
SQLite). The raw signing key is never serialized.

This implements SPEC.md Section 31.6: short lived, audience restricted,
nonce protected, revocable, and never available to model-visible text or
child processes.

# AGENTS.md — terminus-authz

## Local rules

- **Never serialize the signing key.** `TokenIssuer::secret` is private and
  must not appear in any Debug, JSON, or log output.
- **Canonical JSON for signing.** Claims MUST be canonicalized (sorted keys,
  no whitespace) before HMAC. Any change to `canonicalize_json` invalidates
  all previously minted tokens.
- **Nonce replay.** Each token carries a nonce. Issuers record nonces at mint
  time. Reusing a nonce for a new token is currently allowed but SHOULD be
  rejected at the protocol boundary.
- **No `unsafe`.**
- **No panics.** Mutex poisoning is recovered via `into_inner()`.
- **Short TTLs.** Default TTL is 1 hour. Tokens for sensitive operations
  SHOULD request shorter TTLs explicitly.

# AGENTS.md — terminus-remote

## Local rules

- **Single-tenant remote first.** Multi-tenant shared kernel is out of scope
  (ADR-0030). Isolation tests treat one deployment as one trust boundary.
- **mTLS + capability tokens.** Cert identity authenticates the peer; short-lived
  capability tokens still authorize operations (SPEC §30.8, §31.6).
- **Digest-pinned images only.** Mutable tags (`:latest`) are rejected.
- **Disconnect cannot invent success.** Interrupted remote effects land in
  `Unknown` or `ManualReview`, never silent `Settled`.
- **No `unsafe`.** No panics. Typed errors only.
- Pure logic preferred; I/O (TLS sockets, OCI runtimes) lives at call sites.

## What NOT to add

- Shared-kernel multi-tenancy.
- OpenSSL (deny.toml → rustls at the transport boundary).
- Silent truncation of artifact streams.

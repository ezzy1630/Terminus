# AGENTS.md — forge-egress

## Local rules

- **Default deny.** When `default_deny = true` (the default), every
  destination MUST be explicitly allowlisted.
- **Private IPs always denied.** Even when the hostname matches an
  allowlist entry, the resolved IPs MUST be checked against private/loopback/
  link-local ranges. SSRF attempts MUST be rejected.
- **Byte and rate limits.** Every relay MUST go through `relay(bytes)` so
  the budget is enforced.
- **No TLS interception.** The proxy is a stub; do not implement TLS
  interception in this crate. End-to-end TLS goes through the kernel's HTTPS
  client which validates certificates.
- **No `unsafe`.** No panics.

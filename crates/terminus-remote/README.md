# terminus-remote

Single-tenant remote deployment primitives for Terminus (SPEC §48.14 / M11).

## Contents

- Kernel / server / workspace / control identities
- mTLS material descriptors (paths + fingerprints; no private keys in logs)
- Remote environment descriptors
- Digest-pinned image refs and container/micro-VM pool leases
- Quota ledger and admission
- Chunked artifact transfer sessions with resume tokens
- Remote cancellation and effect settlement on disconnect
- Collaboration roles / session handoff
- Audit export redaction controls

Transport sockets live in `mini-services/terminus-kernel` (rustls/tonic).
This crate owns the pure contracts and state machines those sockets enforce.

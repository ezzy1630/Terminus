# ADR-0007: gRPC/Protobuf over UDS for kernel RPC

- **Status:** PROVISIONAL
- **Date:** 2025-07-11
- **Decision owner:** runtime owner
- **Supersedes:** none
- **Related:** SPEC §7.1, §31, Appendix D

## Context

The control plane (`terminus-control`, TypeScript) must call the privileged effect kernel (`terminus-kernel`, Rust) for every process spawn, file mutation, network connection, secret use, and extension execution. This is the most security-critical boundary in Terminus: it must enforce capability tokens, deadlines, cancellation, idempotency, and typed errors. It must not provide a "generic execute arbitrary JSON" escape hatch (SPEC §7.1).

The mini-service implementation currently uses JSON-over-HTTP for bootstrap convenience, but the .proto is the canonical source of truth (SPEC §45.4, Appendix D).

## Decision

Adopt **gRPC/Protobuf over Unix-domain socket (UDS)** for the kernel RPC per SPEC §7.1 and §31:

- **Transport:** UDS locally; mutually authenticated TLS remotely (M11+).
- **Schema:** Protobuf3 in `proto/terminus/kernel/v1/kernel.proto` (Appendix D). Generated types via prost (Rust) and buf (TS clients).
- **Compatibility:** Buf breaking-change checks run in CI (SPEC §45.4). Never reuse field numbers; removed fields are `reserved`; enums reserve `UNSPECIFIED = 0`.
- **Services:** `KernelInfoService`, `FileService`, `PatchService`, `ProcessService`, `JobService`. Future services: sandbox, policy, secrets, network, Git, code-intelligence, extension, artifact-ingest.
- **Auth:** Kernel instance identity + short-lived capability tokens (SPEC §31.6). Every RPC carries a `RequestContext` with `capability_token`.
- **Streaming:** `ProcessService.Start` and `JobService.Stream` return server-streaming responses (`ProcessEvent` / `JobEvent`).
- **Idempotency:** `RequestContext.idempotency_key` enables safe retry of mutating RPCs.

The canonical protocol namespace is **`terminus.kernel.v1`**. The former
`forge.kernel.v1` spelling is not a supported descriptor or compatibility
alias; any future compatibility adapter must be explicit, versioned, and
covered by Buf breaking checks. This namespace decision is part of the v1
contract and is independent of the eventual local gRPC binding choice.

Status is PROVISIONAL because ConnectRPC vs. tonic vs. raw gRPC is subject to a replacement gate during M3. The .proto is stable; the wire binding may be amended.

## Alternatives

- **JSON-over-HTTP.** Rejected for the canonical protocol: no native streaming; weaker schema enforcement; easier to add an "execute arbitrary JSON" escape hatch. Used only as a mini-service bootstrap convenience.
- **Cap'n Proto.** Rejected: smaller ecosystem; weaker tooling; no clear advantage for our payload sizes.
- **FlatBuffers.** Rejected: same as Cap'n Proto.
- **Shared memory / FFI.** Rejected: collapses the process boundary; violates non-bypassability (SPEC §5.2).
- **Raw TCP.** Rejected: no UDS-style filesystem permissions; harder to secure locally.

## Consequences

- The Rust kernel links tonic/prost; the TS control plane links a generated gRPC client.
- A fake kernel (`terminus-kernel-testkit`) implements the same proto for TS-side development.
- Contract tests run current control × current kernel and current control × previous kernel (SPEC §46.6).
- Load/backpressure tests run before each release (SPEC §48.6 exit gate).
- The descriptor set is published with each kernel build.

## Security Impact

Critical. UDS + capability tokens + typed schemas are what make the kernel non-bypassable from the control plane. No generic JSON escape hatch means the model cannot synthesize an arbitrary privileged call.

## Evaluation Plan

- Buf lint + breaking checks run in CI.
- Kernel integration tests run against real OS features (SPEC §46.5).
- Contract tests verify decoding, semantic behavior, and error codes across versions.
- Load tests verify backpressure and cancellation propagate.

## Migration

The mini-service initially uses JSON-over-HTTP for bootstrap. The .proto is the source of truth; the gRPC binding is added in M3 (SPEC §48.6) and the JSON path is removed once the gRPC path is proven.

## Rollback

If gRPC proves too heavy, amend this ADR to ConnectRPC (same .proto, simpler wire). The .proto is stable; only the wire binding changes. Do not silently introduce a JSON escape hatch.

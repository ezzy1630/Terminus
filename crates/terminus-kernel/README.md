# terminus-kernel

The privileged Terminus kernel assembly — wires every service into typed methods.

`KernelHandle` is the top-level type. Construction is cheap; cloning shares
all state behind `Arc`. The kernel is a *library*: every method takes a
`RequestContext` + an `EffectIntent` + a typed request, returns either a
typed response or a `KernelError`. The mini-service exposes the canonical
`terminus.kernel.v1` Protobuf API over a filesystem-restricted Unix-domain
socket.

The 13 service groups (SPEC.md Section 31.1) — `KernelInfoService`,
`WorkspaceService`, `FileService`, `PatchService`, `ProcessService`,
`JobService`, `SandboxService`, `PolicyService`, `SecretService`,
`NetworkService`, `CodeIntelligenceService`, `ExtensionRuntimeService`,
`ArtifactIngestService` — are exposed as fields on `KernelHandle`.

`ArtifactIngestService` verifies content-addressed bytes and owns durable
artifact links. `Link` is capability-checked, rejects unknown content hashes,
and records an idempotent `(hash, owner_type, owner_id, purpose)` relationship
used by reference-aware retention.

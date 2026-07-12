# forge-kernel

The privileged Forge kernel assembly — wires every service into typed methods.

`KernelHandle` is the top-level type. Construction is cheap; cloning shares
all state behind `Arc`. The kernel is a *library*: every method takes a
`RequestContext` + an `EffectIntent` + a typed request, returns either a
typed response or a `KernelError`, and is callable from the JSON-over-HTTP
server in `mini-services/forge-kernel` (a separate agent's job).

The 13 service groups (SPEC.md Section 31.1) — `KernelInfoService`,
`WorkspaceService`, `FileService`, `PatchService`, `ProcessService`,
`JobService`, `SandboxService`, `PolicyService`, `SecretService`,
`NetworkService`, `CodeIntelligenceService`, `ExtensionRuntimeService`,
`ArtifactIngestService` — are exposed as fields on `KernelHandle`.

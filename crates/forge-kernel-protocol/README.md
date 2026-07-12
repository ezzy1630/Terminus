# forge-kernel-protocol

Shared serde-only types for the Forge effect kernel.

This crate mirrors the kernel RPC contract described in `SPEC.md` Appendix D
(`RequestContext`, `EffectIntent`, `WorkspacePath`, `CommandSpec`,
`ShellSpec`, `PatchEdit`, `WorkspaceBaseline`, `ToolResultEnvelope`,
`ProcessEvent`, `ArtifactRef`, `Diagnostic`, etc.) plus the stable error code
enum (Section 30.4). It performs no I/O and intentionally depends only on
`serde`, `serde_json`, `uuid`, `chrono`, and `thiserror`.

Every other crate in the workspace depends on this one so the wire types stay
in sync. Keep changes additive and version-aware: a serialized
`RequestContext` from one Forge build MUST round-trip on the next.

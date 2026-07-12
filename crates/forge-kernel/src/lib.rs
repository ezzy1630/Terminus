//! The Forge kernel assembly — wires every service into typed methods
//! (SPEC.md Section 31.1, 31.7).
//!
//! The kernel is a *library*. The actual HTTP/JSON server lives in
//! `mini-services/forge-kernel` (a separate agent's job); it calls into the
//! methods exposed here. Every method takes a `RequestContext` + an
//! `EffectIntent` + a typed request, and returns either a typed response or
//! a `KernelError`.

#![forbid(unsafe_code)]

mod error;
mod services;

pub use services::{
    ArtifactIngestService, CodeIntelligenceService, ExtensionRuntimeService, FileService,
    JobService, KernelHandle, KernelInfoService, NetworkService, PatchService, PolicyService,
    ProcessService, SandboxService, SecretService, WorkspaceEntry, WorkspaceService,
};
pub use error::KernelAssemblyError;

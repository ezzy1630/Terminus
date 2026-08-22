//! The Terminus kernel assembly — wires every service into typed methods
//! (SPEC.md Section 31.1, 31.7).
//!
//! The kernel is a *library*. The actual HTTP/JSON server lives in
//! `mini-services/terminus-kernel` (a separate agent's job); it calls into the
//! methods exposed here. Every method takes a `RequestContext` + an
//! `EffectIntent` + a typed request, and returns either a typed response or
//! a `KernelError`.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]
#![forbid(unsafe_code)]

mod approvals;
mod error;
mod ledger;
mod services;

pub use approvals::{
    operation_hash, ApprovalRecord, ApprovalRequest, ApprovalRisk, ApprovalScope, ApprovalStatus,
    ApprovalStore,
};
pub use error::KernelAssemblyError;
pub use ledger::{
    KernelAuthorizationInstance, KernelEffectLedger, KernelEffectRecord, KernelEffectState,
};
pub use services::{
    validate_capability_for_op, validate_request_pipeline, ArtifactIngestService, CodeIntelligenceService,
    ConnectorService, ExtensionRuntimeService, FileService, JobService, KernelHandle,
    KernelInfoService, NetworkService, PatchService, PolicyService, ProcessService, SandboxService,
    SecretService, WorkspaceEntry, WorkspaceService,
};

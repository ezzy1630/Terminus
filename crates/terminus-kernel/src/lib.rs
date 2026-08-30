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
pub mod connectors;
mod error;
mod ledger;
pub mod provider_accounts;
mod services;

pub use approvals::{
    operation_hash, ApprovalRecord, ApprovalRequest, ApprovalRisk, ApprovalScope, ApprovalStatus,
    ApprovalStore,
};
pub use connectors::{
    connector_egress_policy, default_connector_registry, with_connector_egress_floor,
    EGRESS_FLOOR_HOSTS,
};
pub use error::KernelAssemblyError;
pub use ledger::{
    KernelAuthorizationInstance, KernelEffectLedger, KernelEffectRecord, KernelEffectState,
};
pub use provider_accounts::{
    ImportedLocalCredential, LocalAuthKind, LocalCredentialDiscovery, LocalCredentialMetadata,
    LocalCredentialRoots, LocalCredentialStore, LocalCredentialStoreStatus,
    LocalProviderCredential, ProviderAccountService, DISCOVER_LOCAL_SCOPE,
};
pub use services::{
    apply_default_deadline, remaining_budget, resolve_deadline_unix_ms, validate_capability_for_op,
    validate_request_pipeline, ArtifactIngestService, CodeIntelligenceService, ConnectorService,
    ExtensionRuntimeService, FileService, JobService, KernelHandle, KernelInfoService,
    NetworkService, PatchService, PolicyService, ProcessService, RpcDeadlineClass, SandboxService,
    SecretService, WorkspaceEntry, WorkspaceService, DEFAULT_UNARY_DEADLINE_MS,
    MAX_LONG_RUNNING_DEADLINE_MS,
};
pub use terminus_secrets::SecretPresence;

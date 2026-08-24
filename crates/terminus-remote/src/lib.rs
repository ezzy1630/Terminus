//! terminus-remote — single-tenant remote deployment contracts (SPEC §48.14).
//!
//! Pure state machines and validators for identities, mTLS material descriptors,
//! environment descriptors, digest-pinned pools, quotas, artifact streaming,
//! settlement on disconnect, collaboration handoff, and audit export controls.
//!
//! Socket I/O lives in `mini-services/terminus-kernel` (rustls/tonic).

#![forbid(unsafe_code)]
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

pub mod artifact_stream;
pub mod audit;
pub mod blueprint;
pub mod collab;
pub mod environment;
pub mod error;
pub mod identity;
pub mod image_pin;
pub mod mtls;
pub mod pool;
pub mod quota;
pub mod settlement;
pub mod upgrade;

pub use artifact_stream::{
    ArtifactStreamManager, ChunkAppendResult, CommittedArtifact, ContinuationToken, StreamSession,
};
pub use audit::{export_audit, AuditExportBundle, AuditExportRequest};
pub use blueprint::{
    BlueprintBackend, BrokeredCredential, DependencyPin, EnvironmentBlueprint, NetworkPolicy,
    PreparedEnvironmentPlan, ServiceBlueprint, ToolchainPin,
};
pub use collab::{CollaborationRegistry, CollaborationRole, HandoffRecord, SessionMembership};
pub use environment::{EnvironmentBackend, RemoteEnvironmentDescriptor};
pub use error::RemoteError;
pub use identity::{DeploymentIdentities, Identity, IdentityKind};
pub use image_pin::{reject_mutable_tag, PinnedImage};
pub use mtls::{KernelTransport, MtlsMaterial};
pub use pool::{ExecutionPool, PoolLease};
pub use quota::{QuotaLedger, QuotaLimits, QuotaResource};
pub use settlement::{DurableEffectRecord, EffectState, ExecutionMode, SettlementLedger};
pub use upgrade::{compatible, ProtocolVersion};

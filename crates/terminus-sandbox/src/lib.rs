//! Sandbox backend trait, profiles, and manager (SPEC.md Section 13.3, 13.4).
//!
//! The kernel talks to a `SandboxManager` that selects a backend per
//! platform. Backends MUST honestly report their effective enforcement in
//! `enforcement_report()` — silently downgrading is forbidden (Section 13.4:
//! "Unsupported/degraded: fail closed in production. The UI must display
//! effective enforcement, never silently downgrade.").

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]
#![forbid(unsafe_code)]

pub mod backend;
pub mod error;
pub mod manager;
pub mod profile;
pub mod report;

pub use backend::{LocalRestrictiveBackend, SandboxBackend};
pub use error::SandboxError;
pub use manager::SandboxManager;
pub use profile::{
    FilesystemAccess, FilesystemRule, NetworkAccess, ProcessAccess, ResourceLimits, SandboxProfile,
    SecretsAccess,
};
pub use report::{EnforcementFeature, EnforcementReport, EnforcementStatus};

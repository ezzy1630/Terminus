//! Secret broker (SPEC.md Section 13.6).
//!
//! The broker:
//! - obtains a short-lived credential for a `secret://provider/scope` URI;
//! - injects it into one isolated process env/fd only;
//! - constrains destination and operation;
//! - redacts matching output;
//! - records the use in an audit log;
//! - revokes afterward.
//!
//! The model never receives the raw secret.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]
#![forbid(unsafe_code)]

mod audit;
mod broker;
mod error;
mod grant;
mod keyring_provider;
mod redact;
mod residue;

pub use audit::{AuditEntry, SecretAuditLog};
pub use broker::{
    InMemoryProvider, SecretBroker, SecretHandle, SecretMetadata, SecretProvider,
    WritableSecretProvider,
};
pub use error::SecretError;
pub use grant::{
    ConnectorGrant, ConsumedGrant, GrantBinding, GrantClaims, GrantIssuer, GrantStore,
    WorkloadIdentity, MAX_GRANT_TTL_SECS,
};
pub use keyring_provider::KeyringSecretProvider;
pub use redact::{RedactionPattern, Redactor};
pub use residue::{CanaryMaterial, ResidueHit, ResidueScanner, ResidueSurface};

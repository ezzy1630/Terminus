//! Errors for terminus-remote.

use thiserror::Error;

/// Errors emitted by remote deployment primitives.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum RemoteError {
    #[error("invalid identity: {0}")]
    InvalidIdentity(String),

    #[error("invalid environment descriptor: {0}")]
    InvalidEnvironment(String),

    #[error("image digest required; mutable tags are forbidden")]
    MutableImageTag,

    #[error("image digest mismatch: expected {expected}, got {actual}")]
    DigestMismatch { expected: String, actual: String },

    #[error("pool exhausted: {0}")]
    PoolExhausted(String),

    #[error("unknown lease: {0}")]
    UnknownLease(String),

    #[error("quota exceeded: {resource} (used {used}, limit {limit})")]
    QuotaExceeded {
        resource: String,
        used: u64,
        limit: u64,
    },

    #[error("artifact stream error: {0}")]
    ArtifactStream(String),

    #[error("settlement error: {0}")]
    Settlement(String),

    #[error("handoff error: {0}")]
    Handoff(String),

    #[error("audit export denied: {0}")]
    AuditDenied(String),

    #[error("identity isolation violation: {0}")]
    IsolationViolation(String),

    #[error("mtls config error: {0}")]
    MtlsConfig(String),
}

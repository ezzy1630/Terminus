use thiserror::Error;

#[derive(Debug, Error)]
pub enum SecretError {
    #[error("unknown secret capability: {0}")]
    UnknownCapability(String),
    #[error("secret capability denied by policy: {0}")]
    Denied(String),
    #[error("secret capability expired: {0}")]
    Expired(String),
    #[error("secret capability revoked: {0}")]
    CapabilityRevoked(String),
    #[error("invalid secret URI: {0}")]
    InvalidUri(String),
    #[error("provider unavailable: {0}")]
    ProviderUnavailable(String),
    /// The credential store did not answer inside
    /// [`crate::SECRET_RESOLVE_TIMEOUT`]. On macOS this is almost always a
    /// SecurityAgent prompt waiting off-screen because the calling binary's
    /// code identity is not on the keychain item's ACL — which is the normal
    /// state of an ad-hoc-signed dev build after a rebuild. The message is
    /// the whole remedy, so it is written to be readable in a gRPC status.
    #[error(
        "secret resolution for {uri} did not complete within {timeout_secs}s: an OS keychain \
         access prompt is probably waiting for approval (approve it for this binary, or run the \
         dev kernel with TERMINUS_SECRETS_BACKEND=file)"
    )]
    ResolveTimeout { uri: String, timeout_secs: u64 },
    #[error("invalid connector grant: {0}")]
    InvalidGrant(String),
    #[error("grant binding mismatch: {0}")]
    BindingMismatch(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("serialization error: {0}")]
    Serialize(#[from] serde_json::Error),
}

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
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("serialization error: {0}")]
    Serialize(#[from] serde_json::Error),
}

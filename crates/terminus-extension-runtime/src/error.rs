use thiserror::Error;

#[derive(Debug, Error)]
pub enum ExtensionError {
    #[error("wasi runtime not available in this build")]
    Unavailable,
    #[error("invalid manifest: {0}")]
    InvalidManifest(String),
    #[error("manifest signature invalid: {0}")]
    InvalidSignature(String),
    #[error("extension denied by policy: {0}")]
    Denied(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("serialization error: {0}")]
    Serialize(#[from] serde_json::Error),
}

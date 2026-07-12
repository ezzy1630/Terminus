use thiserror::Error;

#[derive(Debug, Error)]
pub enum ArtifactError {
    #[error("artifact hash mismatch: expected {expected}, got {actual}")]
    HashMismatch { expected: String, actual: String },
    #[error("artifact not found: {0}")]
    NotFound(String),
    #[error("invalid hash encoding: {0}")]
    InvalidHash(String),
    #[error("content exceeds maximum size ({max} bytes)")]
    TooLarge { max: u64 },
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("serialization error: {0}")]
    Serialize(#[from] serde_json::Error),
    #[error("path is not a valid artifact path")]
    InvalidPath,
    #[error("quarantine rejected: {0}")]
    Quarantine(String),
    #[error("sqlite error: {0}")]
    Sqlite(String),
}

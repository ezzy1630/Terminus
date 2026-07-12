use thiserror::Error;

#[derive(Debug, Error)]
pub enum PatchError {
    #[error("stale source version for {path}: expected {expected}, got {actual}")]
    StaleSource {
        path: String,
        expected: String,
        actual: String,
    },
    #[error("path not found: {0}")]
    PathNotFound(String),
    #[error("file already exists: {0}")]
    AlreadyExists(String),
    #[error("file does not exist: {0}")]
    Missing(String),
    #[error("anchor not found: {0}")]
    AnchorNotFound(String),
    #[error("anchor not unique: {0}")]
    AnchorNotUnique(String),
    #[error("validation failed: {0}")]
    ValidationFailed(String),
    #[error("invalid edit: {0}")]
    InvalidEdit(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("path error: {0}")]
    Path(#[from] forge_fs::PathError),
    #[error("serialization error: {0}")]
    Serialize(#[from] serde_json::Error),
    #[error("transaction aborted: {0}")]
    Aborted(String),
}

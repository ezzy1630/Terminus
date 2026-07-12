use thiserror::Error;

#[derive(Debug, Error)]
pub enum GitError {
    #[error("git not available: {0}")]
    GitUnavailable(String),
    #[error("git operation failed: {0}")]
    OperationFailed(String),
    #[error("protected path: {0}")]
    Protected(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("process error: {0}")]
    Process(#[from] forge_process::ProcessError),
    #[error("invalid ref: {0}")]
    InvalidRef(String),
}

use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProcessError {
    #[error("spawn failed: {0}")]
    Spawn(String),
    #[error("process not found: {0}")]
    NotFound(String),
    #[error("process already exited: {0}")]
    AlreadyExited(String),
    #[error("process timed out after {0}ms")]
    Timeout(u64),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("artifact store error: {0}")]
    Artifact(#[from] terminus_artifacts::ArtifactError),
    #[error("invalid command spec: {0}")]
    InvalidSpec(String),
    #[error("cancelled")]
    Cancelled,
}

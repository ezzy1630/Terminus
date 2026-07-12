use thiserror::Error;

#[derive(Debug, Error)]
pub enum JobError {
    #[error("job not found: {0}")]
    NotFound(String),
    #[error("invalid state transition: {from} -> {to}")]
    InvalidTransition { from: String, to: String },
    #[error("job already started: {0}")]
    AlreadyStarted(String),
    #[error("job already terminal: {0}")]
    AlreadyTerminal(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("process error: {0}")]
    Process(#[from] forge_process::ProcessError),
    #[error("serialization error: {0}")]
    Serialize(#[from] serde_json::Error),
}

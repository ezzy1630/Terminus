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
    Process(#[from] terminus_process::ProcessError),
    #[error("serialization error: {0}")]
    Serialize(#[from] serde_json::Error),
    #[error("sqlite error: {0}")]
    Database(String),
    #[error("job lease mismatch: {0}")]
    LeaseMismatch(String),
    #[error("invalid output stream: {0}")]
    InvalidOutputStream(String),
    #[error("output cursor conflict for job {job_id} stream {stream}: expected {expected}, got {actual}")]
    OutputCursorConflict {
        job_id: String,
        stream: String,
        expected: u64,
        actual: u64,
    },
    #[error(
        "output was compacted for job {job_id} stream {stream}; resume at cursor {available_from}"
    )]
    OutputTruncated {
        job_id: String,
        stream: String,
        available_from: u64,
    },
}

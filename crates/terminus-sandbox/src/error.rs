use thiserror::Error;

#[derive(Debug, Error)]
pub enum SandboxError {
    #[error("sandbox unavailable on this platform: {0}")]
    Unsupported(String),
    #[error("sandbox degraded: {0}")]
    Degraded(String),
    #[error("sandbox misconfigured: {0}")]
    Misconfigured(String),
    #[error("resource limit exceeded: {0}")]
    ResourceLimitExceeded(String),
    #[error("sandbox io error: {0}")]
    Io(#[from] std::io::Error),
}

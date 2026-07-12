use thiserror::Error;

#[derive(Debug, Error)]
pub enum EgressError {
    #[error("destination not allowed: {0}")]
    Denied(String),
    #[error("destination is private or link-local: {0}")]
    PrivateDestination(String),
    #[error("rate limit exceeded")]
    RateLimited,
    #[error("byte budget exceeded")]
    ByteBudgetExceeded,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("dns resolution failed: {0}")]
    Dns(String),
}

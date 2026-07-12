use thiserror::Error;

#[derive(Debug, Error)]
pub enum AuthzError {
    #[error("invalid signature")]
    InvalidSignature,
    #[error("token expired")]
    Expired,
    #[error("token revoked")]
    Revoked,
    #[error("token does not bind to requested principal")]
    WrongPrincipal,
    #[error("token does not bind to requested session")]
    WrongSession,
    #[error("token does not bind to requested task")]
    WrongTask,
    #[error("token does not bind to requested workspace")]
    WrongWorkspace,
    #[error("operation class not permitted by token")]
    OperationNotPermitted,
    #[error("scope exceeds token maximum")]
    ScopeExceeded,
    #[error("token audience mismatch")]
    WrongAudience,
    #[error("token audience mismatch (kernel instance)")]
    InvalidAudience,
    #[error("token replay detected (nonce already used)")]
    Replay,
    #[error("serialization error: {0}")]
    Serialize(#[from] serde_json::Error),
    #[error("invalid hex encoding: {0}")]
    Hex(#[from] hex::FromHexError),
}

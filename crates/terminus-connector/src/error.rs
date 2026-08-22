use thiserror::Error;

#[derive(Debug, Error)]
pub enum ConnectorError {
    #[error("grant invalid: {0}")]
    InvalidGrant(String),
    #[error("grant binding mismatch: {0}")]
    BindingMismatch(String),
    #[error("credential error: {0}")]
    Credential(#[from] terminus_secrets::SecretError),
    #[error("egress denied: {0}")]
    Egress(#[from] terminus_egress::EgressError),
    #[error("https destinations require a validated TLS transport; refusing to send credentials in plaintext")]
    TlsUnavailable,
    #[error("unknown connector: {0}")]
    UnknownConnector(String),
    #[error("request exceeds bounded size {limit}: {actual} bytes")]
    BodyTooLarge { limit: usize, actual: usize },
    #[error("protocol error: {0}")]
    Protocol(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

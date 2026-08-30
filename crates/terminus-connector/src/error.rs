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
    #[error("unknown connector: {0}")]
    UnknownConnector(String),
    #[error("request exceeds bounded size {limit}: {actual} bytes")]
    BodyTooLarge { limit: usize, actual: usize },
    #[error("response exceeds bounded size {limit}: at least {actual} bytes")]
    ResponseTooLarge { limit: usize, actual: usize },
    #[error("request was not dispatched: {0}")]
    RequestNotDispatched(String),
    #[error("protocol error: {0}")]
    Protocol(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    /// The caller tore the dispatch down (the gRPC consumer dropped the
    /// stream, or a cancel was requested). The request may have been
    /// partially executed upstream, so the receipt stays `DispatchUncertain`.
    #[error("dispatch cancelled by the caller")]
    Cancelled,
}

use thiserror::Error;

#[derive(Debug, Error)]
pub enum CodeIntelError {
    #[error("language not indexed: {0}")]
    LanguageNotIndexed(String),
    #[error("symbol not found: {0}")]
    SymbolNotFound(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("serialization error: {0}")]
    Serialize(#[from] serde_json::Error),
}

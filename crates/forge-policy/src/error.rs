use thiserror::Error;

#[derive(Debug, Error)]
pub enum PolicyError {
    #[error("invalid rule file: {0}")]
    InvalidRuleFile(String),
    #[error("yaml parse error: {0}")]
    Yaml(#[from] serde_yaml::Error),
    #[error("json parse error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("rule conflict: {0}")]
    Conflict(String),
}

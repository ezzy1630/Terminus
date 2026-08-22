//! Typed connector receipt: what happened, hashed and attributable, with no
//! secret material (SPEC §17.4, §40).

use serde::{Deserialize, Serialize};

/// Semantic result classification. Retry behavior is explicit per SPEC §40:
/// "Internal error without state guidance is non-conforming."
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    /// 2xx: the semantic action was accepted by the destination.
    Accepted,
    /// 4xx caused by the request content; retrying unchanged will fail again.
    RejectedNonRetryable,
    /// 5xx or transport failure after dispatch: state at the destination is
    /// UNCERTAIN — reconcile before any retry (SPEC §16.3).
    DispatchUncertain,
    /// Connection failed before any byte was sent; safe to re-dispatch a
    /// freshly granted attempt.
    NotDispatched,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectorReceipt {
    pub grant_id: String,
    pub task_id: String,
    pub effect_id: String,
    pub connector_id: String,
    pub method: String,
    pub path: String,
    /// `scheme://host:port` actually connected to.
    pub destination: String,
    /// SHA-256 over method|host|port|path|query|body.
    pub request_sha256: String,
    pub status_code: Option<u16>,
    /// SHA-256 over the response body bytes as received (post-redaction).
    pub response_sha256: Option<String>,
    /// Number of credential-material redactions applied to the response.
    pub response_redactions: usize,
    pub outcome: Outcome,
}

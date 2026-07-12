//! Per-request trace ID propagation.

use axum::extract::Request;
use sha2::{Digest, Sha256};
use std::fmt;

/// A stable per-request trace ID. Sourced from `x-trace-id`, `traceparent`,
/// or generated fresh as a UUIDv7.
#[derive(Debug, Clone)]
pub struct TraceId(pub String);

impl TraceId {
    pub fn new(s: impl Into<String>) -> Self {
        Self(s.into())
    }

    /// Pull a trace ID from the request's `x-trace-id` or `traceparent`
    /// header; otherwise generate a fresh UUIDv7.
    pub fn from_request_or_new(req: &Request) -> Self {
        if let Some(h) = req.headers().get("x-trace-id").and_then(|h| h.to_str().ok()) {
            if !h.is_empty() {
                return Self(h.to_string());
            }
        }
        if let Some(h) = req.headers().get("traceparent").and_then(|h| h.to_str().ok()) {
            // traceparent format: 00-<trace-id>-<span-id>-<flags>
            // We use the trace-id portion.
            let parts: Vec<&str> = h.split('-').collect();
            if parts.len() >= 3 && !parts[1].is_empty() {
                return Self(parts[1].to_string());
            }
        }
        Self(uuid::Uuid::now_v7().to_string())
    }
}

impl fmt::Display for TraceId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Hash a byte slice with SHA-256 and return the `sha256:<hex>` form used
/// by the kernel's `ArtifactRef` and `SourceVersion` types.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("sha256:{}", hex::encode(h.finalize()))
}


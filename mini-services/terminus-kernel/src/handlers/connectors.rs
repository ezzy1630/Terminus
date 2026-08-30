//! ConnectorService — `POST /v1/connectors/grants/mint` and
//! `POST /v1/connectors/execute` (ADR-0035 §2).
//!
//! Grants are opaque and carry no credential material; receipts are hashes
//! plus typed outcome. Raw secret material never crosses this API.

use std::sync::Arc;

use axum::extract::State;
use axum::Extension;
use axum::Json;
use serde::{Deserialize, Serialize};
use terminus_connector::{CanonicalOperation, ConnectorResponse};
use terminus_secrets::GrantBinding;

use crate::api::Envelope;
use crate::auth::ValidatedCapabilityToken;
use crate::error::{json_error, ApiError};
use crate::state::AppState;
use crate::trace_id::TraceId;

#[derive(Debug, Deserialize)]
pub struct GrantMintRequest {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub uri: String,
    pub binding: GrantBinding,
    /// Short-lived by contract; the kernel clamps to its own ceiling.
    #[serde(default = "default_ttl")]
    pub ttl_secs: u64,
    #[serde(default = "default_use_limit")]
    pub use_limit: u32,
}

fn default_ttl() -> u64 {
    300
}

fn default_use_limit() -> u32 {
    1
}

#[derive(Debug, Serialize)]
pub struct GrantMintResponse {
    /// Opaque, signed grant. Safe to hold in task state: contains no
    /// credential material.
    pub grant_encoded: String,
    pub grant_id: String,
    pub expires_at_unix: u64,
}

pub async fn mint_grant(
    State(state): State<Arc<AppState>>,
    Extension(cap_token): Extension<ValidatedCapabilityToken>,
    body: axum::body::Bytes,
) -> Result<Json<GrantMintResponse>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let mut req: GrantMintRequest =
        serde_json::from_slice(&body).map_err(|e| json_error(e, &trace_id.0))?;
    req.envelope.inject_capability_token(&cap_token);
    let grant = state
        .kernel
        .connectors
        // Async variant: a synchronous credential resolve on this worker
        // thread would park the whole runtime behind an OS keychain prompt.
        .mint_grant_async(
            &req.envelope.request_context,
            &req.uri,
            req.binding,
            req.ttl_secs,
            req.use_limit,
        )
        .await
        .map_err(|e| ApiError::from_kernel(e, &trace_id.0))?;
    Ok(Json(GrantMintResponse {
        expires_at_unix: grant.claims.expires_at_unix,
        grant_id: grant.claims.grant_id.clone(),
        grant_encoded: grant.encode().map_err(|e| {
            ApiError::new(
                terminus_kernel_protocol::ErrorCode::InvalidRequest,
                terminus_kernel_protocol::ErrorCategory::Internal,
                format!("encode grant: {e}"),
                &trace_id.0,
            )
        })?,
    }))
}

#[derive(Debug, Deserialize)]
pub struct ConnectorExecuteRequest {
    #[serde(flatten)]
    pub envelope: Envelope,
    /// Signed grant token as returned by `/v1/connectors/grants/mint`.
    pub grant_encoded: String,
    pub operation: CanonicalOperation,
}

#[derive(Debug, Serialize)]
pub struct ConnectorExecuteResponse {
    #[serde(flatten)]
    pub response: ConnectorResponse,
}

pub async fn execute(
    State(state): State<Arc<AppState>>,
    Extension(cap_token): Extension<ValidatedCapabilityToken>,
    body: axum::body::Bytes,
) -> Result<Json<ConnectorExecuteResponse>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let mut req: ConnectorExecuteRequest =
        serde_json::from_slice(&body).map_err(|e| json_error(e, &trace_id.0))?;
    req.envelope.inject_capability_token(&cap_token);
    // Decode + signature-verify against the kernel's grant key before any
    // service work. A tampered token fails here with a typed error; the
    // signing key never leaves the service.
    let grant = state
        .kernel
        .connectors
        .decode_grant(&req.grant_encoded)
        .map_err(|e| {
            ApiError::new(
                terminus_kernel_protocol::ErrorCode::CapabilityTokenInvalid,
                terminus_kernel_protocol::ErrorCategory::Permission,
                format!("{e}"),
                &trace_id.0,
            )
        })?;
    let response = state
        .kernel
        .connectors
        .execute(&req.envelope.request_context, &req.operation, &grant)
        .await
        .map_err(|e| ApiError::from_kernel(e, &trace_id.0))?;
    Ok(Json(ConnectorExecuteResponse { response }))
}

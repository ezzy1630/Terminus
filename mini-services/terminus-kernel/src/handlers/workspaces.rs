//! WorkspaceService — `POST /v1/workspaces/register` and
//! `POST /v1/workspaces/:id/get`.

use axum::extract::{Path, State};
use axum::Extension;
use axum::Json;
use serde::Deserialize;
use std::sync::Arc;

use crate::api::Envelope;
use crate::auth::ValidatedCapabilityToken;
use crate::error::{json_error, ApiError};
use crate::state::AppState;
use crate::trace_id::TraceId;

#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub root_uri: String,
    #[serde(default)]
    pub canonical_root: String,
    /// SPEC §28.2: `trusted | untrusted | restricted`. Omitting it defaults
    /// to `untrusted` (fail-safe) inside the kernel.
    #[serde(default)]
    pub trust: String,
}

#[derive(Debug, serde::Serialize)]
pub struct RegisterResponse {
    pub workspace_id: String,
}

pub async fn register(
    State(state): State<Arc<AppState>>,
    Extension(cap_token): Extension<ValidatedCapabilityToken>,
    body: axum::body::Bytes,
) -> Result<Json<RegisterResponse>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let mut req: RegisterRequest =
        serde_json::from_slice(&body).map_err(|e| json_error(e, &trace_id.0))?;
    req.envelope.inject_capability_token(&cap_token);
    terminus_kernel::validate_request_pipeline(
        &state.kernel.token_issuer,
        &req.envelope.request_context,
        terminus_authz::OperationClass::Admin,
        &terminus_authz::Scope::default(),
        false,
    )
    .map_err(|error| ApiError::from_kernel(error, &trace_id.0))?;
    let canonical = if req.canonical_root.is_empty() {
        req.root_uri.clone()
    } else {
        req.canonical_root
    };
    let id = state
        .kernel
        .workspaces
        .register(
            &req.envelope.request_context,
            &req.envelope.effect_intent,
            req.root_uri,
            canonical,
            &req.trust,
        )
        .map_err(|e| ApiError::from_kernel(e, &trace_id.0))?;
    Ok(Json(RegisterResponse { workspace_id: id }))
}

pub async fn get(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Extension(cap_token): Extension<ValidatedCapabilityToken>,
    body: axum::body::Bytes,
) -> Result<Json<terminus_kernel::WorkspaceEntry>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let mut envelope = if body.is_empty() {
        Envelope::from_value(&serde_json::json!({}))
    } else {
        serde_json::from_slice(&body)
    }
    .map_err(|error| json_error(error, &trace_id.0))?;
    envelope.inject_capability_token(&cap_token);
    envelope.request_context.workspace_id = id.clone();
    terminus_kernel::validate_request_pipeline(
        &state.kernel.token_issuer,
        &envelope.request_context,
        terminus_authz::OperationClass::Read,
        &terminus_authz::Scope::default(),
        false,
    )
    .map_err(|error| ApiError::from_kernel(error, &trace_id.0))?;
    let entry = state
        .kernel
        .workspaces
        .get(&envelope.request_context, &id)
        .map_err(|e| ApiError::from_kernel(e, &trace_id.0))?;
    Ok(Json(entry))
}

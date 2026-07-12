//! WorkspaceService — `POST /v1/workspaces/register` and
//! `POST /v1/workspaces/:id/get`.

use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use std::sync::Arc;

use crate::api::Envelope;
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
    body: axum::body::Bytes,
) -> Result<Json<RegisterResponse>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let req: RegisterRequest =
        serde_json::from_slice(&body).map_err(|e| json_error(e, &trace_id.0))?;
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
    body: axum::body::Bytes,
) -> Result<Json<terminus_kernel::WorkspaceEntry>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    // Body is allowed to be `{}` or contain an envelope; we ignore it.
    let _ = body;
    let entry = state
        .kernel
        .workspaces
        .get(&id)
        .map_err(|e| ApiError::from_kernel(e, &trace_id.0))?;
    Ok(Json(entry))
}

//! PatchService — `POST /v1/patch/preview`, `POST /v1/patch/apply`,
//! and `POST /v1/patch/reconcile`.

use axum::extract::State;
use axum::Extension;
use axum::Json;
use serde::Deserialize;
use std::sync::Arc;
use terminus_kernel_protocol::{PatchCommitMode, PatchEdit, PatchResponse, WorkspaceBaseline};

use crate::api::Envelope;
use crate::auth::ValidatedCapabilityToken;
use crate::error::{json_error, ApiError};
use crate::state::AppState;
use crate::trace_id::TraceId;

#[derive(Debug, Deserialize)]
pub struct PatchRequest {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub transaction_id: String,
    #[serde(default)]
    pub baseline: WorkspaceBaseline,
    pub edits: Vec<PatchEdit>,
}

pub async fn preview(
    State(state): State<Arc<AppState>>,
    Extension(cap_token): Extension<ValidatedCapabilityToken>,
    body: axum::body::Bytes,
) -> Result<Json<PatchResponse>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let mut req: PatchRequest =
        serde_json::from_slice(&body).map_err(|e| json_error(e, &trace_id.0))?;
    req.envelope.inject_capability_token(&cap_token);
    let response = state
        .kernel
        .patches
        .apply_with_mode(
            &req.envelope.request_context,
            &req.envelope.effect_intent,
            &req.transaction_id,
            &req.baseline,
            &req.edits,
            PatchCommitMode::PreviewOnly,
        )
        .map_err(|e| ApiError::from_kernel(e, &trace_id.0))?;
    Ok(Json(response))
}

pub async fn apply(
    State(state): State<Arc<AppState>>,
    Extension(cap_token): Extension<ValidatedCapabilityToken>,
    body: axum::body::Bytes,
) -> Result<Json<PatchResponse>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let mut req: PatchRequest =
        serde_json::from_slice(&body).map_err(|e| json_error(e, &trace_id.0))?;
    req.envelope.inject_capability_token(&cap_token);
    let response = state
        .kernel
        .patches
        .apply_with_mode(
            &req.envelope.request_context,
            &req.envelope.effect_intent,
            &req.transaction_id,
            &req.baseline,
            &req.edits,
            PatchCommitMode::ApplyToWorktree,
        )
        .map_err(|e| ApiError::from_kernel(e, &trace_id.0))?;
    Ok(Json(response))
}

#[derive(Debug, Deserialize)]
pub struct ReconcileRequest {
    #[serde(flatten)]
    pub envelope: Envelope,
    #[serde(default)]
    pub transaction_id: String,
}

pub async fn reconcile(
    State(state): State<Arc<AppState>>,
    Extension(cap_token): Extension<ValidatedCapabilityToken>,
    body: axum::body::Bytes,
) -> Result<Json<PatchResponse>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let mut req: ReconcileRequest =
        serde_json::from_slice(&body).map_err(|e| json_error(e, &trace_id.0))?;
    if req.transaction_id.is_empty() {
        return Err(ApiError::validation(
            "transaction_id is required",
            &trace_id.0,
        ));
    }
    req.envelope.inject_capability_token(&cap_token);
    let response = state
        .kernel
        .patches
        .reconcile(&req.envelope.request_context, &req.transaction_id)
        .map_err(|e| ApiError::from_kernel(e, &trace_id.0))?;
    Ok(Json(response))
}

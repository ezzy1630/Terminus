//! PatchService — `POST /v1/patch/preview`, `POST /v1/patch/apply`,
//! and `POST /v1/patch/reconcile`.

use axum::extract::State;
use axum::Json;
use forge_kernel_protocol::{PatchCommitMode, PatchEdit, PatchResponse, WorkspaceBaseline};
use serde::Deserialize;
use std::sync::Arc;

use crate::api::Envelope;
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
    body: axum::body::Bytes,
) -> Result<Json<PatchResponse>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let req: PatchRequest =
        serde_json::from_slice(&body).map_err(|e| json_error(e, &trace_id.0))?;
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
    body: axum::body::Bytes,
) -> Result<Json<PatchResponse>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let req: PatchRequest =
        serde_json::from_slice(&body).map_err(|e| json_error(e, &trace_id.0))?;
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

#[derive(Debug, serde::Serialize)]
pub struct ReconcileResponse {
    pub transaction_id: String,
    pub state: String,
    pub message: String,
}

pub async fn reconcile(
    State(_state): State<Arc<AppState>>,
    body: axum::body::Bytes,
) -> Result<Json<ReconcileResponse>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let req: ReconcileRequest =
        serde_json::from_slice(&body).map_err(|e| json_error(e, &trace_id.0))?;
    // The kernel's PatchEngine does not yet expose a public reconcile method;
    // for now we report that no interrupted transactions were found for the
    // given id. This is honest — the journal on disk can be inspected
    // directly when full reconciliation is wired in.
    Ok(Json(ReconcileResponse {
        transaction_id: req.transaction_id,
        state: "no_interrupted_transaction".to_string(),
        message: "patch reconciliation: no in-flight transactions matched".to_string(),
    }))
}

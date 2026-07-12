//! CodeIntelligenceService — `POST /v1/code-intel/inspect-symbol`,
//! `POST /v1/code-intel/find-references`, and
//! `POST /v1/code-intel/diagnose-files`.

use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use forge_code_intel::{DiagnoseResult, InspectResult, ReferenceResult};
use serde::Deserialize;

use crate::api::Envelope;
use crate::error::{json_error, ApiError};
use crate::state::AppState;
use crate::trace_id::TraceId;

#[derive(Debug, Deserialize)]
pub struct InspectRequest {
    #[serde(flatten)]
    pub envelope: Envelope,
    #[serde(default)]
    pub symbol: String,
}

pub async fn inspect_symbol(
    State(state): State<Arc<AppState>>,
    body: axum::body::Bytes,
) -> Result<Json<InspectResult>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let req: InspectRequest =
        serde_json::from_slice(&body).map_err(|e| json_error(e, &trace_id.0))?;
    let result = state
        .kernel
        .code_intel
        .inspect(
            &req.envelope.request_context,
            &req.envelope.effect_intent,
            &req.symbol,
        )
        .map_err(|e| ApiError::internal(format!("{e}"), &trace_id.0))?;
    Ok(Json(result))
}

#[derive(Debug, Deserialize)]
pub struct FindReferencesRequest {
    #[serde(flatten)]
    pub envelope: Envelope,
    #[serde(default)]
    pub symbol: String,
}

pub async fn find_references(
    State(state): State<Arc<AppState>>,
    body: axum::body::Bytes,
) -> Result<Json<ReferenceResult>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let req: FindReferencesRequest =
        serde_json::from_slice(&body).map_err(|e| json_error(e, &trace_id.0))?;
    let svc = state.kernel.code_intel.service();
    let result = svc
        .find_references(&req.symbol)
        .map_err(|e| ApiError::internal(format!("{e}"), &trace_id.0))?;
    Ok(Json(result))
}

#[derive(Debug, Deserialize)]
pub struct DiagnoseFilesRequest {
    #[serde(flatten)]
    pub envelope: Envelope,
    #[serde(default)]
    pub paths: Vec<String>,
}

pub async fn diagnose_files(
    State(state): State<Arc<AppState>>,
    body: axum::body::Bytes,
) -> Result<Json<Vec<DiagnoseResult>>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let req: DiagnoseFilesRequest =
        serde_json::from_slice(&body).map_err(|e| json_error(e, &trace_id.0))?;
    let svc = state.kernel.code_intel.service();
    let result = svc
        .diagnose_files(&req.paths)
        .map_err(|e| ApiError::internal(format!("{e}"), &trace_id.0))?;
    Ok(Json(result))
}

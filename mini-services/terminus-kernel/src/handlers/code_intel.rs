//! CodeIntelligenceService — `POST /v1/code-intel/inspect-symbol`,
//! `POST /v1/code-intel/find-references`, and
//! `POST /v1/code-intel/diagnose-files`.

use std::sync::Arc;

use axum::extract::State;
use axum::Extension;
use axum::Json;
use serde::Deserialize;
use terminus_code_intel::{DiagnoseResult, InspectResult, ReferenceResult};

use crate::api::Envelope;
use crate::auth::ValidatedCapabilityToken;
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
    Extension(cap_token): Extension<ValidatedCapabilityToken>,
    body: axum::body::Bytes,
) -> Result<Json<InspectResult>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let mut req: InspectRequest =
        serde_json::from_slice(&body).map_err(|e| json_error(e, &trace_id.0))?;
    req.envelope.inject_capability_token(&cap_token);
    let result = state
        .kernel
        .code_intel
        .inspect(
            &req.envelope.request_context,
            &req.envelope.effect_intent,
            &req.symbol,
        )
        .map_err(|e| ApiError::from_kernel(e, &trace_id.0))?;
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
    Extension(cap_token): Extension<ValidatedCapabilityToken>,
    body: axum::body::Bytes,
) -> Result<Json<ReferenceResult>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let mut req: FindReferencesRequest =
        serde_json::from_slice(&body).map_err(|e| json_error(e, &trace_id.0))?;
    req.envelope.inject_capability_token(&cap_token);
    let result = state
        .kernel
        .code_intel
        .find_references(
            &req.envelope.request_context,
            &req.envelope.effect_intent,
            &req.symbol,
        )
        .map_err(|e| ApiError::from_kernel(e, &trace_id.0))?;
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
    Extension(cap_token): Extension<ValidatedCapabilityToken>,
    body: axum::body::Bytes,
) -> Result<Json<Vec<DiagnoseResult>>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let mut req: DiagnoseFilesRequest =
        serde_json::from_slice(&body).map_err(|e| json_error(e, &trace_id.0))?;
    req.envelope.inject_capability_token(&cap_token);
    let result = state
        .kernel
        .code_intel
        .diagnose_files(
            &req.envelope.request_context,
            &req.envelope.effect_intent,
            &req.paths,
        )
        .map_err(|e| ApiError::from_kernel(e, &trace_id.0))?;
    Ok(Json(result))
}

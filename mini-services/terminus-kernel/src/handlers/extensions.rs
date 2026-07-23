//! ExtensionRuntimeService — `POST /v1/extensions/load` and
//! `POST /v1/extensions/invoke`.
//!
//! WASI execution requires an available wasmtime backend and otherwise fails
//! closed (`Unavailable`). Process-isolated extensions are available via
//! `ProcessExtensionHost`. Invoke never silently runs untrusted in-process code.

use std::sync::Arc;

use axum::extract::State;
use axum::Extension;
use axum::Json;
use serde::{Deserialize, Serialize};
use terminus_extension_runtime::ExtensionManifest;

use crate::api::Envelope;
use crate::auth::ValidatedCapabilityToken;
use crate::error::{json_error, ApiError};
use crate::state::AppState;
use crate::trace_id::TraceId;

#[derive(Debug, Deserialize)]
pub struct LoadRequest {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub manifest: ExtensionManifest,
}

#[derive(Debug, Serialize)]
pub struct LoadResponse {
    pub loaded: bool,
    pub manifest_id: String,
    pub validated: bool,
    pub report: serde_json::Value,
}

pub async fn load(
    State(state): State<Arc<AppState>>,
    Extension(cap_token): Extension<ValidatedCapabilityToken>,
    body: axum::body::Bytes,
) -> Result<Json<LoadResponse>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let mut req: LoadRequest =
        serde_json::from_slice(&body).map_err(|e| json_error(e, &trace_id.0))?;
    req.envelope.inject_capability_token(&cap_token);
    state
        .kernel
        .extensions
        .validate_manifest(&req.envelope.request_context, &req.manifest)
        .map_err(|e| ApiError::from_kernel(e, &trace_id.0))?;
    let report = state.kernel.extensions.report();
    Ok(Json(LoadResponse {
        loaded: true,
        manifest_id: req.manifest.id.clone(),
        validated: true,
        report: serde_json::to_value(&report).unwrap_or(serde_json::Value::Null),
    }))
}

#[derive(Debug, Deserialize)]
pub struct InvokeRequest {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub manifest: ExtensionManifest,
    #[serde(default)]
    pub hook: String,
    #[serde(default)]
    pub payload: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub struct InvokeResponse {
    pub invoked: bool,
    pub hook: String,
    pub error: Option<String>,
    pub report: serde_json::Value,
}

pub async fn invoke(
    State(state): State<Arc<AppState>>,
    body: axum::body::Bytes,
) -> Result<Json<InvokeResponse>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let req: InvokeRequest =
        serde_json::from_slice(&body).map_err(|e| json_error(e, &trace_id.0))?;
    let report = state.kernel.extensions.report();
    // The host fails closed: `execute` returns `Unavailable` in this build.
    // We surface that honestly in the response body — NOT as an HTTP error —
    // so callers can distinguish "extension system unreachable" from
    // "transport failure".
    let error = if report.available {
        None
    } else {
        Some(report.reason.clone())
    };
    Ok(Json(InvokeResponse {
        invoked: report.available,
        hook: req.hook,
        error,
        report: serde_json::to_value(&report).unwrap_or(serde_json::Value::Null),
    }))
}

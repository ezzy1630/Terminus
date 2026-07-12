//! SandboxService — `GET /v1/sandbox/backends` and
//! `POST /v1/sandbox/select`.

use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use terminus_sandbox::SandboxProfile;
use serde::{Deserialize, Serialize};

use crate::api::Envelope;
use crate::error::{json_error, ApiError};
use crate::state::AppState;
use crate::trace_id::TraceId;

#[derive(Debug, Serialize)]
pub struct BackendsResponse {
    pub default_backend: String,
    pub enforcement_report: serde_json::Value,
    pub backends: Vec<BackendEntry>,
}

#[derive(Debug, Serialize)]
pub struct BackendEntry {
    pub id: String,
    pub status: String,
}

pub async fn backends(
    State(state): State<Arc<AppState>>,
) -> Result<Json<BackendsResponse>, ApiError> {
    let report = state.kernel.sandboxes.enforcement_report();
    let backends = vec![BackendEntry {
        id: report.backend_id.clone(),
        status: format!("{:?}", report.status),
    }];
    Ok(Json(BackendsResponse {
        default_backend: report.backend_id.clone(),
        enforcement_report: serde_json::to_value(&report).unwrap_or(serde_json::Value::Null),
        backends,
    }))
}

#[derive(Debug, Deserialize)]
pub struct SelectRequest {
    #[serde(flatten)]
    pub envelope: Envelope,
    #[serde(default)]
    pub profile_id: String,
    #[serde(default)]
    pub profile: Option<SandboxProfile>,
}

#[derive(Debug, Serialize)]
pub struct SelectResponse {
    pub selected_backend: String,
    pub status: String,
}

pub async fn select(
    State(state): State<Arc<AppState>>,
    body: axum::body::Bytes,
) -> Result<Json<SelectResponse>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let req: SelectRequest =
        serde_json::from_slice(&body).map_err(|e| json_error(e, &trace_id.0))?;
    let profile = req
        .profile
        .unwrap_or_else(SandboxProfile::default_restrictive);
    let backend = state
        .kernel
        .sandboxes
        .select_public(&profile)
        .map_err(|e| {
            ApiError::new(
                terminus_kernel_protocol::ErrorCode::SandboxUnavailable,
                terminus_kernel_protocol::ErrorCategory::SandboxUnavailable,
                format!("{e}"),
                &trace_id.0,
            )
        })?;
    let report = backend.enforcement_report();
    Ok(Json(SelectResponse {
        selected_backend: report.backend_id,
        status: format!("{:?}", report.status),
    }))
}

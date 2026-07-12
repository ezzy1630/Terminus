//! KernelInfoService — `POST /v1/info` and `POST /v1/health`.

use axum::extract::State;
use axum::Json;
use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;

use crate::api::Envelope;
use crate::error::{json_error, ApiError};
use crate::state::AppState;
use crate::trace_id::TraceId;

#[derive(Debug, Serialize)]
pub struct InfoResponse {
    pub version: String,
    pub build_commit: String,
    pub instance_id: String,
    pub kernel_started_at: String,
    pub services: Vec<String>,
}

pub async fn info(State(state): State<Arc<AppState>>, body: axum::body::Bytes) -> Result<Json<InfoResponse>, ApiError> {
    let _trace = TraceId::from_request_or_new(&axum::extract::Request::default());
    let _envelope: Envelope = serde_json::from_slice::<Envelope>(&body)
        .map_err(|e| json_error(e, "info"))?;
    let info = state.kernel.info.info();
    let services = info
        .get("services")
        .and_then(|s| s.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(Json(InfoResponse {
        version: env!("CARGO_PKG_VERSION").to_string(),
        build_commit: state.build_commit.clone(),
        instance_id: state.kernel.info.instance_id().to_string(),
        kernel_started_at: state.started_at.clone(),
        services,
    }))
}

#[derive(Debug, Serialize)]
pub struct HealthResponse {
    pub status: String,
    pub ready: bool,
    pub enforcement_report: Value,
    pub supported_backends: Vec<String>,
    pub instance_id: String,
    pub version: String,
}

pub async fn health(
    State(state): State<Arc<AppState>>,
    body: axum::body::Bytes,
) -> Result<Json<HealthResponse>, ApiError> {
    let _envelope: Envelope = serde_json::from_slice::<Envelope>(&body)
        .map_err(|e| json_error(e, "health"))?;
    let enforcement = state.kernel.sandboxes.enforcement_report();
    let supported_backends = vec!["local-restrictive".to_string()];
    Ok(Json(HealthResponse {
        status: "ok".to_string(),
        ready: true,
        enforcement_report: serde_json::to_value(&enforcement).unwrap_or(Value::Null),
        supported_backends,
        instance_id: state.kernel.info.instance_id().to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    }))
}

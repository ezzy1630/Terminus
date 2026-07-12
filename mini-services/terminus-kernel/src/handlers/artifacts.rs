//! ArtifactIngestService — `POST /v1/artifacts/ingest` (raw bytes),
//! `GET /v1/artifacts/:hash` (raw bytes), `GET /v1/artifacts/:hash/metadata`,
//! and `POST /v1/artifacts/gc`.

use std::collections::HashSet;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::header;
use axum::http::HeaderValue;
use axum::response::{IntoResponse, Response};
use axum::Json;
use terminus_artifacts::ArtifactMetadata;
use serde::{Deserialize, Serialize};

use crate::api::Envelope;
use crate::error::{json_error, ApiError};
use crate::state::AppState;
use crate::trace_id::TraceId;

/// `POST /v1/artifacts/ingest` — accepts raw bytes
/// (`Content-Type: application/octet-stream`) and returns an `ArtifactRef`.
pub async fn ingest(
    State(state): State<Arc<AppState>>,
    body: Bytes,
) -> Result<Json<terminus_kernel_protocol::ArtifactRef>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    // For the dev mini-service, the body IS the artifact bytes; no envelope
    // is required (and we cannot parse an envelope from binary content).
    // We use the kernel's artifact ingest directly.
    let artifact = state
        .kernel
        .artifact_ingest
        .ingest_with_bytes(&body)
        .map_err(|e| ApiError::from_kernel(e, &trace_id.0))?;
    Ok(Json(artifact))
}

/// `GET /v1/artifacts/:hash` — returns raw bytes.
pub async fn get(
    State(state): State<Arc<AppState>>,
    Path(hash): Path<String>,
) -> Result<Response, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let store = state.kernel.artifact_ingest.store();
    let bytes = store.get(&hash).map_err(|e| {
        ApiError::new(
            terminus_kernel_protocol::ErrorCode::ArtifactNotFound,
            terminus_kernel_protocol::ErrorCategory::NotFound,
            format!("{e}"),
            &trace_id.0,
        )
    })?;
    // Infer media type from metadata if available.
    let media_type = store
        .metadata(&hash)
        .map(|m| m.media_type)
        .unwrap_or_else(|_| "application/octet-stream".to_string());
    let mut resp = bytes.into_response();
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&media_type)
            .unwrap_or(HeaderValue::from_static("application/octet-stream")),
    );
    Ok(resp)
}

/// `GET /v1/artifacts/:hash/metadata` — returns the artifact metadata JSON.
pub async fn metadata(
    State(state): State<Arc<AppState>>,
    Path(hash): Path<String>,
) -> Result<Json<ArtifactMetadata>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let store = state.kernel.artifact_ingest.store();
    let meta = store.metadata(&hash).map_err(|e| {
        ApiError::new(
            terminus_kernel_protocol::ErrorCode::ArtifactNotFound,
            terminus_kernel_protocol::ErrorCategory::NotFound,
            format!("{e}"),
            &trace_id.0,
        )
    })?;
    Ok(Json(meta))
}

#[derive(Debug, Deserialize)]
pub struct GcRequest {
    #[serde(flatten)]
    pub envelope: Envelope,
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default)]
    pub live: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct GcResponse {
    pub dry_run: bool,
    pub scanned: usize,
    pub referenced: usize,
    pub collectable: Vec<String>,
    pub retained: Vec<String>,
    pub deleted: Vec<String>,
    pub errors: Vec<String>,
}

/// `POST /v1/artifacts/gc` — garbage-collect (or dry-run) unreferenced
/// artifacts.
pub async fn gc(
    State(state): State<Arc<AppState>>,
    body: Bytes,
) -> Result<Json<GcResponse>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let req: GcRequest = serde_json::from_slice(&body).map_err(|e| json_error(e, &trace_id.0))?;
    let store = state.kernel.artifact_ingest.store();
    let live: HashSet<String> = req.live.into_iter().collect();
    if req.dry_run {
        let report = store
            .gc_dry_run(&live)
            .map_err(|e| ApiError::internal(format!("gc dry-run: {e}"), &trace_id.0))?;
        Ok(Json(GcResponse {
            dry_run: true,
            scanned: report.scanned,
            referenced: report.referenced,
            collectable: report.collectable,
            retained: report.retained,
            deleted: Vec::new(),
            errors: Vec::new(),
        }))
    } else {
        let report = store
            .gc_collect(&live)
            .map_err(|e| ApiError::internal(format!("gc collect: {e}"), &trace_id.0))?;
        Ok(Json(GcResponse {
            dry_run: false,
            scanned: report.dry_run.scanned,
            referenced: report.dry_run.referenced,
            collectable: report.dry_run.collectable,
            retained: report.dry_run.retained,
            deleted: report.deleted,
            errors: report.errors,
        }))
    }
}

//! ArtifactIngestService — `POST /v1/artifacts/ingest` (raw bytes),
//! `GET /v1/artifacts/:hash` (raw bytes), `GET /v1/artifacts/:hash/metadata`,
//! and `POST /v1/artifacts/gc`.

use std::collections::HashSet;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use terminus_artifacts::ArtifactMetadata;
use terminus_authz::TokenClaims;
use terminus_kernel_protocol::RequestContext;

use crate::api::Envelope;
use crate::auth::ValidatedCapabilityToken;
use crate::error::{json_error, ApiError};
use crate::state::AppState;
use crate::trace_id::TraceId;

/// `POST /v1/artifacts/ingest` — accepts raw bytes
/// (`Content-Type: application/octet-stream`) and returns an `ArtifactRef`.
pub async fn ingest(
    State(state): State<Arc<AppState>>,
    Extension(cap_token): Extension<ValidatedCapabilityToken>,
    Extension(claims): Extension<TokenClaims>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<terminus_kernel_protocol::ArtifactRef>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let context = artifact_context(&headers, &cap_token, &claims, &trace_id)?;
    let artifact = state
        .kernel
        .artifact_ingest
        .ingest(&context, &Default::default(), &body)
        .map_err(|e| ApiError::from_kernel(e, &trace_id.0))?;
    Ok(Json(artifact))
}

/// `GET /v1/artifacts/:hash` — returns raw bytes.
pub async fn get(
    State(state): State<Arc<AppState>>,
    Path(hash): Path<String>,
    Extension(cap_token): Extension<ValidatedCapabilityToken>,
    Extension(claims): Extension<TokenClaims>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let context = artifact_context(&headers, &cap_token, &claims, &trace_id)?;
    let bytes = state
        .kernel
        .artifact_ingest
        .get(&context, &hash)
        .map_err(|error| ApiError::from_kernel(error, &trace_id.0))?;
    // Infer media type from metadata if available.
    let media_type = state
        .kernel
        .artifact_ingest
        .metadata_record(&context, &hash)
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
    Extension(cap_token): Extension<ValidatedCapabilityToken>,
    Extension(claims): Extension<TokenClaims>,
    headers: HeaderMap,
) -> Result<Json<ArtifactMetadata>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let context = artifact_context(&headers, &cap_token, &claims, &trace_id)?;
    let meta = state
        .kernel
        .artifact_ingest
        .metadata_record(&context, &hash)
        .map_err(|error| ApiError::from_kernel(error, &trace_id.0))?;
    Ok(Json(meta))
}

fn artifact_context(
    headers: &HeaderMap,
    cap_token: &ValidatedCapabilityToken,
    claims: &TokenClaims,
    trace_id: &TraceId,
) -> Result<RequestContext, ApiError> {
    let task_id = if claims.binder.task_id == "*" {
        required_header(headers, "x-terminus-task-id", trace_id)?
    } else {
        claims.binder.task_id.clone()
    };
    let mut context = RequestContext::new(uuid::Uuid::now_v7().to_string());
    context.actor_id = if claims.binder.principal == "*" {
        "terminus-kernel-http".to_string()
    } else {
        claims.binder.principal.clone()
    };
    context.session_id = bound_or_header(
        &claims.binder.session_id,
        headers,
        "x-terminus-session-id",
        "artifact-http",
    );
    context.task_id = task_id;
    context.workspace_id = bound_or_header(
        &claims.binder.workspace_id,
        headers,
        "x-terminus-workspace-id",
        "",
    );
    context.traceparent = trace_id.0.clone();
    context.capability_token = cap_token.0.clone();
    Ok(context)
}

fn bound_or_header(binder: &str, headers: &HeaderMap, name: &str, fallback: &str) -> String {
    if binder != "*" {
        return binder.to_string();
    }
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn required_header(
    headers: &HeaderMap,
    name: &str,
    trace_id: &TraceId,
) -> Result<String, ApiError> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| {
            ApiError::new(
                terminus_kernel_protocol::ErrorCode::InvalidRequest,
                terminus_kernel_protocol::ErrorCategory::Validation,
                format!("{name} is required when the capability uses a wildcard task binder"),
                &trace_id.0,
            )
        })
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
    Extension(cap_token): Extension<ValidatedCapabilityToken>,
    body: Bytes,
) -> Result<Json<GcResponse>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let mut req: GcRequest =
        serde_json::from_slice(&body).map_err(|e| json_error(e, &trace_id.0))?;
    req.envelope.inject_capability_token(&cap_token);
    let live: HashSet<String> = req.live.into_iter().collect();
    if req.dry_run {
        let report = state
            .kernel
            .artifact_ingest
            .gc_dry_run(&req.envelope.request_context, &live)
            .map_err(|error| ApiError::from_kernel(error, &trace_id.0))?;
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
        let report = state
            .kernel
            .artifact_ingest
            .gc_collect(&req.envelope.request_context, &live)
            .map_err(|error| ApiError::from_kernel(error, &trace_id.0))?;
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

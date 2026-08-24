//! FileService — `POST /v1/files/read` and `POST /v1/files/list`.
//!
//! The kernel's `FileService::read` returns the file bytes plus an
//! `ArtifactRef` after ingesting them into the CAS. `list` walks a
//! directory under the workspace root and returns entries with their
//! sha256 hashes; the kernel does not yet expose a public `list` method,
//! so we implement it directly using `std::fs::read_dir` over a path
//! resolved by the kernel's workspace-bound file service.

use axum::extract::State;
use axum::Extension;
use axum::Json;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use terminus_kernel_protocol::WorkspacePath;

use crate::api::Envelope;
use crate::auth::ValidatedCapabilityToken;
use crate::error::{json_error, ApiError};
use crate::state::AppState;
use crate::trace_id::{sha256_hex, TraceId};

#[derive(Debug, Deserialize)]
pub struct ReadFileRequest {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub path: WorkspacePath,
}

#[derive(Debug, Serialize)]
pub struct ReadFileResponse {
    pub artifact: terminus_kernel_protocol::ArtifactRef,
    pub model_projection_utf8: String,
    pub source_version: String,
    pub elisions: Vec<serde_json::Value>,
    pub diagnostics: Vec<serde_json::Value>,
    pub size_bytes: u64,
    pub media_type: String,
}

pub async fn read(
    State(state): State<Arc<AppState>>,
    Extension(cap_token): Extension<ValidatedCapabilityToken>,
    body: axum::body::Bytes,
) -> Result<Json<ReadFileResponse>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let mut req: ReadFileRequest =
        serde_json::from_slice(&body).map_err(|e| json_error(e, &trace_id.0))?;
    req.envelope.inject_capability_token(&cap_token);
    let (bytes, artifact) = state
        .kernel
        .files
        .read(
            &req.envelope.request_context,
            &req.envelope.effect_intent,
            &req.path,
        )
        .map_err(|e| ApiError::from_kernel(e, &trace_id.0))?;
    let model_projection_utf8 = String::from_utf8_lossy(&bytes).to_string();
    let source_version = artifact.sha256.clone();
    Ok(Json(ReadFileResponse {
        artifact,
        model_projection_utf8,
        source_version,
        elisions: Vec::new(),
        diagnostics: Vec::new(),
        size_bytes: bytes.len() as u64,
        media_type: "text/plain; charset=utf-8".to_string(),
    }))
}

#[derive(Debug, Deserialize)]
pub struct ListFilesRequest {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub path: WorkspacePath,
}

#[derive(Debug, Serialize)]
pub struct ListEntry {
    pub relative_path: String,
    pub kind: String,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Serialize)]
pub struct ListFilesResponse {
    pub entries: Vec<ListEntry>,
    pub scanned: usize,
}

pub async fn list(
    State(state): State<Arc<AppState>>,
    Extension(cap_token): Extension<ValidatedCapabilityToken>,
    body: axum::body::Bytes,
) -> Result<Json<ListFilesResponse>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let mut req: ListFilesRequest =
        serde_json::from_slice(&body).map_err(|e| json_error(e, &trace_id.0))?;
    req.envelope.inject_capability_token(&cap_token);
    // §31.3 steps 3-5: validate the workspace-bound capability, select the
    // registered root, then reject traversal/symlink escape.
    let resolved = state
        .kernel
        .files
        .resolve_for_read(&req.envelope.request_context, &req.path)
        .map_err(|error| ApiError::from_kernel(error, &trace_id.0))?;
    let base = &resolved.host.host_path;
    let mut entries = Vec::new();
    let read_dir = match std::fs::read_dir(base) {
        Ok(rd) => rd,
        Err(e) => {
            return Err(ApiError::new(
                terminus_kernel_protocol::ErrorCode::PathNotFound,
                terminus_kernel_protocol::ErrorCategory::NotFound,
                format!("list {}: {e}", base.display()),
                trace_id.0,
            ));
        }
    };
    let mut scanned = 0usize;
    for entry in read_dir.flatten() {
        scanned += 1;
        let file_type = entry.file_type();
        let kind = match &file_type {
            Ok(ft) if ft.is_dir() => "directory",
            Ok(ft) if ft.is_file() => "file",
            Ok(_) => "other",
            Err(_) => "unknown",
        };
        let rel = entry
            .path()
            .strip_prefix(base)
            .unwrap_or(&entry.path())
            .to_string_lossy()
            .to_string();
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        let hash = if kind == "file" {
            match std::fs::read(entry.path()) {
                Ok(bytes) => {
                    let mut h = Sha256::new();
                    h.update(&bytes);
                    format!("sha256:{}", hex::encode(h.finalize()))
                }
                Err(_) => String::new(),
            }
        } else {
            String::new()
        };
        entries.push(ListEntry {
            relative_path: rel,
            kind: kind.to_string(),
            size_bytes: size,
            sha256: hash,
        });
    }
    // Sort for determinism.
    entries.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    let _ = sha256_hex; // re-export marker
    Ok(Json(ListFilesResponse { entries, scanned }))
}

//! ProcessService — `POST /v1/process/start`, `POST /v1/process/:id/cancel`,
//! and `GET /v1/process/:id/output?cursor=N`.

use axum::extract::{Path, Query, State};
use axum::Json;
use forge_kernel_protocol::{CommandSpec, OutputChunk, ProcessEvent};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::task::JoinHandle;

use crate::api::Envelope;
use crate::error::{json_error, ApiError};
use crate::state::AppState;
use crate::trace_id::TraceId;

#[derive(Debug, Deserialize)]
pub struct StartProcessRequest {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub command: CommandSpec,
}

#[derive(Debug, Serialize)]
pub struct StartProcessResponse {
    pub process_id: String,
    pub job_id: String,
    pub resolved_executable: String,
}

pub async fn start(
    State(state): State<Arc<AppState>>,
    body: axum::body::Bytes,
) -> Result<Json<StartProcessResponse>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let req: StartProcessRequest =
        serde_json::from_slice(&body).map_err(|e| json_error(e, &trace_id.0))?;

    // The kernel's ProcessService.start returns a Receiver<ProcessEvent>. We
    // spawn the process, take the Started event to get the process_id, then
    // consume the rest in a background task that accumulates output chunks.
    let mut rx = state
        .kernel
        .processes
        .start(
            &req.envelope.request_context,
            &req.envelope.effect_intent,
            req.command.clone(),
        )
        .await
        .map_err(|e| ApiError::from_kernel(e, &trace_id.0))?;

    // The first event MUST be ProcessEvent::Started; we wait for it (with a
    // short timeout) to get the ids.
    let first = match tokio::time::timeout(std::time::Duration::from_millis(2_000), rx.recv()).await {
        Ok(Some(ev)) => ev,
        _ => {
            return Err(ApiError::internal(
                "process failed to emit Started event within 2s",
                trace_id.0,
            ));
        }
    };
    let (process_id, job_id, resolved_executable) = match first {
        ProcessEvent::Started(s) => (s.process_id, s.job_id, s.resolved_executable),
        other => {
            return Err(ApiError::internal(
                format!("expected Started event, got {other:?}"),
                trace_id.0,
            ));
        }
    };

    // Spawn a background task that accumulates stdout/stderr chunks and
    // captures the Exited event.
    let outputs = Arc::clone(&state.process_outputs);
    let exits = Arc::clone(&state.process_exits);
    let pid = process_id.clone();
    let _handle: JoinHandle<()> = tokio::spawn(async move {
        let mut chunks: Vec<OutputChunk> = Vec::new();
        while let Some(ev) = rx.recv().await {
            match ev {
                ProcessEvent::Stdout(c) | ProcessEvent::Stderr(c) => {
                    chunks.push(c);
                }
                ProcessEvent::Exited(e) => {
                    let mut guard = exits.lock().await;
                    guard.insert(pid.clone(), e);
                    break;
                }
                _ => {}
            }
        }
        let mut guard = outputs.lock().await;
        guard.insert(pid, chunks);
    });

    Ok(Json(StartProcessResponse {
        process_id,
        job_id,
        resolved_executable,
    }))
}

#[derive(Debug, Deserialize)]
pub struct CancelProcessRequest {
    #[serde(flatten)]
    pub envelope: Envelope,
    #[serde(default)]
    pub reason: String,
}

#[derive(Debug, Serialize)]
pub struct CancelProcessResponse {
    pub process_id: String,
    pub status: String,
}

pub async fn cancel(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    body: axum::body::Bytes,
) -> Result<Json<CancelProcessResponse>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let req: CancelProcessRequest =
        serde_json::from_slice(&body).map_err(|e| json_error(e, &trace_id.0))?;
    let reason = if req.reason.is_empty() { "cancelled" } else { &req.reason };
    let status = state
        .kernel
        .processes
        .cancel(
            &req.envelope.request_context,
            &id,
            reason,
        )
        .await
        .map_err(|e| ApiError::from_kernel(e, &trace_id.0))?;
    Ok(Json(CancelProcessResponse {
        process_id: id,
        status,
    }))
}

#[derive(Debug, Deserialize)]
pub struct OutputQuery {
    #[serde(default)]
    pub cursor: u64,
}

#[derive(Debug, Serialize)]
pub struct OutputResponse {
    pub process_id: String,
    pub cursor: u64,
    pub chunks: Vec<OutputChunk>,
    pub exited: Option<forge_kernel_protocol::ProcessExited>,
}

pub async fn output(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Json<OutputResponse>, ApiError> {
    let _trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let cursor = q
        .get("cursor")
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    let chunks = {
        let guard = state.process_outputs.lock().await;
        guard.get(&id).cloned().unwrap_or_default()
    };
    let filtered: Vec<OutputChunk> = chunks.into_iter().filter(|c| c.cursor > cursor).collect();
    let new_cursor = filtered.last().map(|c| c.cursor).unwrap_or(cursor);
    let exited = {
        let guard = state.process_exits.lock().await;
        guard.get(&id).cloned()
    };
    Ok(Json(OutputResponse {
        process_id: id,
        cursor: new_cursor,
        chunks: filtered,
        exited,
    }))
}

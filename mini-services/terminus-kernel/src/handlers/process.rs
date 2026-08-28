//! ProcessService — `POST /v1/process/start`, `POST /v1/process/:id/cancel`,
//! and `GET /v1/process/:id/output?cursor=N`.

use axum::extract::{Path, Query, State};
use axum::Extension;
use axum::Json;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use terminus_kernel_protocol::{CommandSpec, OutputChunk, ProcessEvent};

use crate::api::Envelope;
use crate::auth::ValidatedCapabilityToken;
use crate::error::{json_error, ApiError};
use crate::state::{AppState, ProcessOutputBuffer, MAX_RETAINED_OUTPUT_BYTES};
use crate::trace_id::TraceId;

#[derive(Debug, Deserialize)]
pub struct StartProcessRequest {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub command: CommandSpec,
    /// SPEC §13.3 sandbox profile id (e.g. `secure-local-default`). Empty
    /// defaults to `secure-local-default` inside the handler.
    #[serde(default)]
    pub sandbox_profile_id: String,
}

#[derive(Debug, Serialize)]
pub struct StartProcessResponse {
    pub process_id: String,
    pub job_id: String,
    pub resolved_executable: String,
}

pub async fn start(
    State(state): State<Arc<AppState>>,
    Extension(cap_token): Extension<ValidatedCapabilityToken>,
    body: axum::body::Bytes,
) -> Result<Json<StartProcessResponse>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let mut req: StartProcessRequest =
        serde_json::from_slice(&body).map_err(|e| json_error(e, &trace_id.0))?;
    req.envelope.inject_capability_token(&cap_token);

    // Start through JobService so the process identity, output chunks, and
    // terminal event are durable before the request returns. The process
    // projection remains backward-compatible, but its source of truth is now
    // the same restart-survivable job record used by `/v1/jobs`.
    let profile = if req.sandbox_profile_id.is_empty() {
        "secure-local-default"
    } else {
        &req.sandbox_profile_id
    };
    let (durable_job_id, _outcome, mut rx) = state
        .kernel
        .jobs
        .start(
            &req.envelope.request_context,
            &req.envelope.effect_intent,
            req.command.clone(),
            profile,
            true,
        )
        .await
        .map_err(|e| ApiError::from_kernel(e, &trace_id.0))?;

    // The first event MUST be ProcessEvent::Started; we wait for it (with a
    // short timeout) to get the ids.
    let Ok(Some(first)) =
        tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv()).await
    else {
        return Err(ApiError::internal(
            "process failed to emit Started event within 2s",
            trace_id.0,
        ));
    };
    let (process_id, process_job_id, resolved_executable) = match first.clone() {
        ProcessEvent::Started(s) => (s.process_id, s.job_id, s.resolved_executable),
        other => {
            return Err(ApiError::internal(
                format!("expected Started event, got {other:?}"),
                trace_id.0,
            ));
        }
    };

    let manager = state.kernel.jobs.manager().clone();
    let lease_token = manager
        .get(&durable_job_id)
        .await
        .ok_or_else(|| ApiError::internal("job disappeared after start", &trace_id.0))?
        .lease_token;
    persist_job_event(&manager, &durable_job_id, &lease_token, &first)
        .await
        .map_err(|error| {
            ApiError::internal(
                format!("process event persistence failed: {error}"),
                &trace_id.0,
            )
        })?;

    // The AppState supervisor owns this task and aborts/joins it during
    // server shutdown.
    let outputs = Arc::clone(&state.process_outputs);
    let exits = Arc::clone(&state.process_exits);
    let pid = process_id.clone();
    let event_job_id = durable_job_id.clone();
    state
        .spawn_background(async move {
            let mut chunks: Vec<OutputChunk> = Vec::new();
            let mut retained_bytes = 0usize;
            let mut truncated = false;
            while let Some(ev) = rx.recv().await {
                if let Err(error) = persist_job_event(&manager, &event_job_id, &lease_token, &ev).await
                {
                    tracing::error!(
                        target: "terminus_kernel_audit",
                        event = "process_event_persistence_failed",
                        process_id = %pid,
                        %error,
                        "stopping process projection observer after durable event failure"
                    );
                    break;
                }
                match ev {
                    ProcessEvent::Stdout(c) | ProcessEvent::Stderr(c) => {
                        retained_bytes += c.bytes.len();
                        chunks.push(c);
                        // Bound retention: drop OLDEST chunks once the byte
                        // cap is hit (cursors keep increasing, so cursor-
                        // based polls remain correct). Full output for the
                        // job already lives in the artifact spill.
                        while retained_bytes > MAX_RETAINED_OUTPUT_BYTES {
                            let Some(first) = chunks.first() else {
                                break;
                            };
                            retained_bytes -= first.bytes.len();
                            chunks.remove(0);
                            truncated = true;
                        }
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
            guard.insert(pid, ProcessOutputBuffer::new(chunks, truncated));
        })
        .await;

    Ok(Json(StartProcessResponse {
        process_id,
        job_id: process_job_id,
        resolved_executable,
    }))
}

async fn persist_job_event(
    manager: &terminus_jobs::JobManager,
    job_id: &str,
    lease_token: &str,
    event: &ProcessEvent,
) -> Result<(), String> {
    const MAX_DATABASE_RETRIES: usize = 5;
    for attempt in 0..=MAX_DATABASE_RETRIES {
        match manager
            .record_event_with_lease(job_id, lease_token, event)
            .await
        {
            Ok(()) => return Ok(()),
            Err(terminus_jobs::JobError::Database(error))
                if attempt < MAX_DATABASE_RETRIES =>
            {
                tracing::warn!(
                    target: "terminus_kernel_audit",
                    event = "process_event_persistence_retry",
                    %job_id,
                    attempt = attempt + 1,
                    %error,
                    "retrying durable process event persistence"
                );
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            Err(error) => {
                return Err(format!(
                    "durable process event persistence failed for {job_id}: {error}"
                ));
            }
        }
    }
    Err(format!(
        "durable process event persistence exhausted retries for {job_id}"
    ))
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
    Extension(cap_token): Extension<ValidatedCapabilityToken>,
    body: axum::body::Bytes,
) -> Result<Json<CancelProcessResponse>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let mut req: CancelProcessRequest =
        serde_json::from_slice(&body).map_err(|e| json_error(e, &trace_id.0))?;
    req.envelope.inject_capability_token(&cap_token);
    let reason = if req.reason.is_empty() {
        "cancelled"
    } else {
        &req.reason
    };
    let status = state
        .kernel
        .processes
        .cancel(&req.envelope.request_context, &id, reason)
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
    pub exited: Option<terminus_kernel_protocol::ProcessExited>,
    /// True when older output was dropped from the retained buffer because
    /// the per-process byte cap was hit (the full stream remains in the
    /// artifact spill).
    #[serde(default)]
    pub truncated: bool,
    /// Explicit continuation for a bounded projection. The artifact refs are
    /// the durable escape hatch when the requested byte cursor predates the
    /// retained chunk window.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continuation: Option<OutputContinuation>,
}

#[derive(Debug, Serialize)]
pub struct OutputContinuation {
    pub cursor: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout_artifact: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr_artifact: Option<String>,
}

pub async fn output(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Json<OutputResponse>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let cursor = q
        .get("cursor")
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    let (mut chunks, mut truncated, memory_projection_present) = {
        // Clone only the tail the client has not seen; cloning the whole
        // history per poll made every request O(total output).
        let guard = state.process_outputs.lock().await;
        guard.get(&id).map_or_else(
            || (Vec::new(), false, false),
            |buffer| {
                let chunks = buffer
                    .chunks
                    .iter()
                    .filter(|chunk| chunk.cursor > cursor)
                    .cloned()
                    .collect();
                (chunks, buffer.truncated, true)
            },
        )
    };
    let mut continuation = None;
    let mut exited = {
        let guard = state.process_exits.lock().await;
        guard.get(&id).cloned()
    };

    // The process-local maps are deliberately bounded and are cleared on a
    // kernel restart. Reconstruct the projection from the durable job record
    // and its retained stdout/stderr chunks when that fast path is absent.
    let manager = state.kernel.jobs.manager().clone();
    if let Some(record) = manager.find_by_process_id(&id).await {
        let mut durable_chunks = Vec::new();
        let mut available_from = 0_u64;
        for stream in ["stdout", "stderr"] {
            match manager.output_since(&record.id, stream, cursor).await {
                Ok(stream_chunks) => durable_chunks.extend(stream_chunks.into_iter().map(|chunk| {
                    OutputChunk {
                        cursor: chunk.end_cursor,
                        bytes: chunk.bytes,
                        redacted: chunk.redacted,
                    }
                })),
                Err(terminus_jobs::JobError::OutputTruncated {
                    available_from: stream_cursor,
                    ..
                }) => {
                    truncated = true;
                    available_from = available_from.max(stream_cursor);
                }
                Err(error) => {
                    return Err(ApiError::internal(
                        format!("durable process output replay failed: {error}"),
                        &trace_id.0,
                    ));
                }
            }
        }
        durable_chunks.sort_by_key(|chunk| chunk.cursor);
        if !memory_projection_present
            && (!durable_chunks.is_empty() || record.state.is_terminal() || truncated)
        {
            chunks = durable_chunks;
        }
        if record.state == terminus_jobs::JobState::Exited {
            exited = process_exit_from_record(&record);
        }
        let record_boundary = record
            .stdout_truncated_before
            .max(record.stderr_truncated_before);
        let continuation_cursor = available_from.max(record_boundary);
        if truncated && continuation_cursor > 0 {
            continuation = Some(OutputContinuation {
                cursor: continuation_cursor,
                stdout_artifact: record.stdout_artifact.clone(),
                stderr_artifact: record.stderr_artifact.clone(),
            });
        }
    }

    if truncated && continuation.is_none() {
        let memory_boundary = chunks.first().map_or(cursor, |chunk| {
            chunk
                .cursor
                .saturating_sub(chunk.bytes.len() as u64)
        });
        continuation = Some(OutputContinuation {
            cursor: memory_boundary,
            stdout_artifact: None,
            stderr_artifact: None,
        });
    }

    let new_cursor = chunks.last().map_or(cursor, |chunk| chunk.cursor);
    Ok(Json(OutputResponse {
        process_id: id,
        cursor: new_cursor,
        chunks,
        exited,
        truncated,
        continuation,
    }))
}

fn process_exit_from_record(
    record: &terminus_jobs::JobRecord,
) -> Option<terminus_kernel_protocol::ProcessExited> {
    if record.state != terminus_jobs::JobState::Exited {
        return None;
    }
    let (exit_code, signal) = record
        .termination_receipt
        .as_deref()
        .map_or_else(|| (-1, String::new()), termination_projection);
    let artifact = |sha256: &Option<String>| {
        sha256
            .as_ref()
            .map(|sha256| terminus_kernel_protocol::ArtifactRef {
                sha256: sha256.clone(),
                size_bytes: 0,
                media_type: String::new(),
            })
    };
    Some(terminus_kernel_protocol::ProcessExited {
        exit_code,
        signal,
        exited_at: record.settled_at.clone().unwrap_or_default(),
        stdout_artifact: artifact(&record.stdout_artifact),
        stderr_artifact: artifact(&record.stderr_artifact),
    })
}

fn termination_projection(receipt: &str) -> (i32, String) {
    if let Some(code) = receipt.strip_prefix("exit:") {
        return (code.parse::<i32>().unwrap_or(-1), String::new());
    }
    if let Some(signal) = receipt.strip_prefix("signal:") {
        return (-1, signal.to_string());
    }
    (-1, receipt.to_string())
}

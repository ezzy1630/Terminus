//! ProcessService — `POST /v1/process/start`, `POST /v1/process/:id/cancel`,
//! and `GET /v1/process/:id/output?cursor=N`.

use axum::extract::{Path, Query, State};
use axum::Extension;
use axum::Json;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use terminus_authz::TokenClaims;
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
    let (durable_job_id, outcome, mut rx) = state
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
    let first = match tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv()).await {
        Ok(Some(event)) => event,
        _ => {
            let compensated = compensate_unobserved_process(
                state.kernel.jobs.manager(),
                &durable_job_id,
                &outcome,
                "process did not emit its Started event",
            )
            .await;
            return Err(ApiError::internal(
                if compensated {
                    "process failed to emit Started event within 2s; spawned process was stopped"
                } else {
                    "process failed to emit Started event within 2s; process compensation failed"
                },
                trace_id.0,
            ));
        }
    };
    let (process_id, process_job_id, resolved_executable) = match first.clone() {
        ProcessEvent::Started(s) => (s.process_id, s.job_id, s.resolved_executable),
        other => {
            let compensated = compensate_unobserved_process(
                state.kernel.jobs.manager(),
                &durable_job_id,
                &outcome,
                "process emitted a non-Started first event",
            )
            .await;
            return Err(ApiError::internal(
                format!(
                    "expected Started event, got {other:?}; process compensation {}",
                    if compensated { "succeeded" } else { "failed" }
                ),
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
    if let Err(error) = persist_job_event(&manager, &durable_job_id, &lease_token, &first).await {
        let compensated = compensate_unobserved_process(
            &manager,
            &durable_job_id,
            &outcome,
            "initial process event persistence failed",
        )
        .await;
        return Err(ApiError::internal(
            format!(
                "process event persistence failed: {error}; process compensation {}",
                if compensated { "succeeded" } else { "failed" }
            ),
            &trace_id.0,
        ));
    }

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
                if let Err(error) =
                    persist_job_event(&manager, &event_job_id, &lease_token, &ev).await
                {
                    tracing::error!(
                        target: "terminus_kernel_audit",
                        event = "process_event_persistence_failed",
                        process_id = %pid,
                        %error,
                        "stopping process projection observer after durable event failure"
                    );
                    compensate_unobserved_process(
                        &manager,
                        &event_job_id,
                        &outcome,
                        "process event persistence failed",
                    )
                    .await;
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

/// A process whose durable event chain is broken must not continue outside
/// kernel observation. Cancellation is attempted through the tracked process
/// id and then the fenced OS identity; the durable job is marked orphaned so
/// a later reconciliation cannot mistake it for a clean exit.
async fn compensate_unobserved_process(
    manager: &terminus_jobs::JobManager,
    job_id: &str,
    outcome: &terminus_process::SpawnOutcome,
    reason: &str,
) -> bool {
    if let Err(error) = manager.compensate_spawned(outcome, reason).await {
        tracing::error!(
            target: "terminus_kernel_audit",
            event = "unobserved_process_compensation_failed",
            %job_id,
            process_id = %outcome.process_id,
            %error,
            "failed to stop a process after its durable event chain broke"
        );
        return false;
    }
    if let Err(error) = manager.mark_orphaned(job_id).await {
        tracing::error!(
            target: "terminus_kernel_audit",
            event = "compensated_process_settlement_failed",
            %job_id,
            process_id = %outcome.process_id,
            %error,
            "process was stopped but its durable orphaned state could not be recorded"
        );
    }
    true
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
            Err(terminus_jobs::JobError::Database(error)) if attempt < MAX_DATABASE_RETRIES => {
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
    pub cursor: Option<u64>,
    #[serde(default)]
    pub stdout_cursor: Option<u64>,
    #[serde(default)]
    pub stderr_cursor: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct OutputResponse {
    pub process_id: String,
    /// Compatibility cursor for legacy clients. It advances conservatively
    /// across both streams and may replay bytes, but never skips one stream.
    pub cursor: u64,
    pub stdout_cursor: u64,
    pub stderr_cursor: u64,
    pub stdout_chunks: Vec<OutputChunk>,
    pub stderr_chunks: Vec<OutputChunk>,
    /// Deprecated stream-ambiguous projection retained for old clients.
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
    pub stdout_cursor: u64,
    pub stderr_cursor: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout_artifact: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr_artifact: Option<String>,
}

pub async fn output(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(q): Query<OutputQuery>,
    Extension(claims): Extension<TokenClaims>,
) -> Result<Json<OutputResponse>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let manager = state.kernel.jobs.manager().clone();
    let record = manager
        .find_by_process_id(&id)
        .await
        .ok_or_else(|| ApiError::not_found(format!("process {id} not found"), &trace_id.0))?;
    authorize_process_owner(&record, &claims, &trace_id.0)?;

    let compatibility_cursor = q.cursor.unwrap_or(0);
    let requested_stdout_cursor = q.stdout_cursor.unwrap_or(compatibility_cursor);
    let requested_stderr_cursor = q.stderr_cursor.unwrap_or(compatibility_cursor);
    let stdout = durable_process_output(
        &manager,
        &record.id,
        "stdout",
        requested_stdout_cursor,
        &trace_id.0,
    )
    .await?;
    let stderr = durable_process_output(
        &manager,
        &record.id,
        "stderr",
        requested_stderr_cursor,
        &trace_id.0,
    )
    .await?;
    let stdout_cursor = stdout
        .chunks
        .last()
        .map_or(requested_stdout_cursor, |chunk| chunk.cursor);
    let stderr_cursor = stderr
        .chunks
        .last()
        .map_or(requested_stderr_cursor, |chunk| chunk.cursor);
    let cursor = conservative_legacy_cursor(stdout_cursor, stderr_cursor);
    let mut chunks = stdout.chunks.clone();
    chunks.extend(stderr.chunks.iter().cloned());
    chunks.sort_by_key(|chunk| chunk.cursor);
    let truncated = stdout.available_from.is_some() || stderr.available_from.is_some();
    let continuation = truncated.then(|| {
        let stdout_boundary = stdout
            .available_from
            .unwrap_or(record.stdout_truncated_before);
        let stderr_boundary = stderr
            .available_from
            .unwrap_or(record.stderr_truncated_before);
        OutputContinuation {
            cursor: conservative_legacy_cursor(stdout_boundary, stderr_boundary),
            stdout_cursor: stdout_boundary,
            stderr_cursor: stderr_boundary,
            stdout_artifact: record.stdout_artifact.clone(),
            stderr_artifact: record.stderr_artifact.clone(),
        }
    });
    let exited = process_exit_from_record(&record);
    Ok(Json(OutputResponse {
        process_id: id,
        cursor,
        stdout_cursor,
        stderr_cursor,
        stdout_chunks: stdout.chunks,
        stderr_chunks: stderr.chunks,
        chunks,
        exited,
        truncated,
        continuation,
    }))
}

struct DurableProcessOutput {
    chunks: Vec<OutputChunk>,
    available_from: Option<u64>,
}

async fn durable_process_output(
    manager: &terminus_jobs::JobManager,
    job_id: &str,
    stream: &str,
    cursor: u64,
    trace_id: &str,
) -> Result<DurableProcessOutput, ApiError> {
    match manager.output_since(job_id, stream, cursor).await {
        Ok(chunks) => Ok(DurableProcessOutput {
            chunks: chunks
                .into_iter()
                .map(|chunk| OutputChunk {
                    cursor: chunk.end_cursor,
                    bytes: chunk.bytes,
                    redacted: chunk.redacted,
                })
                .collect(),
            available_from: None,
        }),
        Err(terminus_jobs::JobError::OutputTruncated { available_from, .. }) => {
            Ok(DurableProcessOutput {
                chunks: Vec::new(),
                available_from: Some(available_from),
            })
        }
        Err(error) => Err(ApiError::internal(
            format!("durable process {stream} replay failed: {error}"),
            trace_id,
        )),
    }
}

fn authorize_process_owner(
    record: &terminus_jobs::JobRecord,
    claims: &TokenClaims,
    trace_id: &str,
) -> Result<(), ApiError> {
    if claims.binder.task_id != "*" && claims.binder.task_id != record.owner_task_id {
        return Err(ApiError::permission_denied(
            "process capability is bound to a different task",
            trace_id,
        ));
    }
    Ok(())
}

/// Legacy clients have one cursor for two byte-addressed streams. Advancing
/// to the larger value can lose the lagging stream permanently; the smaller
/// non-zero boundary may replay bytes, but cannot skip them.
fn conservative_legacy_cursor(stdout_cursor: u64, stderr_cursor: u64) -> u64 {
    match (stdout_cursor, stderr_cursor) {
        (0, stderr) => stderr,
        (stdout, 0) => stdout,
        (stdout, stderr) => stdout.min(stderr),
    }
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

#[cfg(test)]
mod tests {
    use super::conservative_legacy_cursor;

    #[test]
    fn legacy_cursor_never_advances_past_the_lagging_stream() {
        assert_eq!(conservative_legacy_cursor(100, 50), 50);
        assert_eq!(conservative_legacy_cursor(50, 100), 50);
        assert_eq!(conservative_legacy_cursor(100, 0), 100);
        assert_eq!(conservative_legacy_cursor(0, 50), 50);
    }
}

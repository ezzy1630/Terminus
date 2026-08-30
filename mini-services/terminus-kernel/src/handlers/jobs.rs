//! JobService — `POST /v1/jobs/start`, `GET /v1/jobs/:id/stream` (SSE),
//! `POST /v1/jobs/:id/input`, `POST /v1/jobs/:id/signal`,
//! `POST /v1/jobs/:id/stop`, `GET /v1/jobs/:id`.

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Extension, Path, Query, State};
use axum::http::HeaderMap;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};
use terminus_authz::TokenClaims;
use terminus_jobs::{JobError, JobRecord, JobState};
use terminus_kernel_protocol::CommandSpec;

use crate::api::Envelope;
use crate::auth::ValidatedCapabilityToken;
use crate::error::{json_error, ApiError};
use crate::state::AppState;
use crate::trace_id::TraceId;

#[derive(Debug, Deserialize)]
pub struct StartJobRequest {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub command: CommandSpec,
    #[serde(default)]
    pub command_str: String,
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub task_id: String,
    #[serde(default)]
    pub sandbox_profile_id: String,
    #[serde(default)]
    pub durable: bool,
}

#[derive(Debug, Serialize)]
pub struct StartJobResponse {
    pub job_id: String,
    pub state: String,
}

pub async fn start(
    State(state): State<Arc<AppState>>,
    Extension(cap_token): Extension<ValidatedCapabilityToken>,
    body: axum::body::Bytes,
) -> Result<Json<StartJobResponse>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let mut req: StartJobRequest =
        serde_json::from_slice(&body).map_err(|e| json_error(e, &trace_id.0))?;
    // The kernel re-validates the capability token (§31.3 step 3) against the
    // requested operation class and scope; a body-supplied token can never
    // grant more authority than the middleware-validated header token.
    req.envelope.inject_capability_token(&cap_token);
    let mut ctx = req.envelope.request_context.clone();
    if !req.session_id.is_empty() {
        ctx.session_id = req.session_id.clone();
    }
    if !req.task_id.is_empty() {
        ctx.task_id = req.task_id.clone();
    }
    let profile = if req.sandbox_profile_id.is_empty() {
        "secure-local-default"
    } else {
        req.sandbox_profile_id.as_str()
    };
    // Durable jobs must go through the same §31.3 pipeline as every other
    // effect: capability → policy → approval → sandbox → audit. Spawning via
    // the raw process manager here would bypass policy and sandbox entirely.
    let (job_id, _outcome, mut receiver) = state
        .kernel
        .jobs
        .start(
            &ctx,
            &req.envelope.effect_intent,
            req.command.clone(),
            profile,
            req.durable,
        )
        .await
        .map_err(|e| ApiError::from_kernel(e, &trace_id.0))?;
    // Drain the bounded event stream so the child is not left backpressured;
    // reconnecting consumers read through the durable job record instead.
    let manager = state.kernel.jobs.manager().clone();
    let event_job_id = job_id.clone();
    let lease_token = manager
        .get(&job_id)
        .await
        .ok_or_else(|| ApiError::internal("job disappeared after start", &trace_id.0))?
        .lease_token;
    state
        .spawn_background(async move {
            'events: while let Some(event) = receiver.recv().await {
                loop {
                    match manager
                        .record_event_with_lease(&event_job_id, &lease_token, &event)
                        .await
                    {
                        Ok(()) => break,
                        Err(error) => {
                            if matches!(error, JobError::Database(_)) {
                                tracing::error!(
                                    job_id = %event_job_id,
                                    %error,
                                    "durable job event persistence failed; retrying before draining the next event"
                                );
                                tokio::time::sleep(Duration::from_millis(100)).await;
                            } else {
                                tracing::error!(
                                    job_id = %event_job_id,
                                    %error,
                                    "durable job event could not be persisted; stopping the observer"
                                );
                                break 'events;
                            }
                        }
                    }
                }
            }
        })
        .await;
    let state_now = state
        .kernel
        .jobs
        .manager()
        .state(&job_id)
        .await
        .ok_or_else(|| ApiError::internal("job disappeared after start", &trace_id.0))?;
    Ok(Json(StartJobResponse {
        job_id,
        state: state_now.as_str().to_string(),
    }))
}

#[derive(Debug, Serialize)]
pub struct JobStateResponse {
    pub job_id: String,
    pub state: String,
    pub record: Option<JobRecord>,
}

fn authorize_job_owner(
    record: &JobRecord,
    claims: &TokenClaims,
    request_task_id: Option<&str>,
    trace_id: &str,
) -> Result<(), ApiError> {
    if claims.binder.task_id != "*" && claims.binder.task_id != record.owner_task_id {
        return Err(ApiError::permission_denied(
            "job capability is bound to a different task",
            trace_id,
        ));
    }
    if let Some(task_id) = request_task_id.filter(|value| !value.is_empty()) {
        if task_id != record.owner_task_id {
            return Err(ApiError::permission_denied(
                "job request task does not own the job",
                trace_id,
            ));
        }
    }
    Ok(())
}

pub async fn get(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Extension(claims): Extension<TokenClaims>,
) -> Result<Json<JobStateResponse>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let manager = state.kernel.jobs.manager().clone();
    let record = manager
        .get(&id)
        .await
        .ok_or_else(|| ApiError::not_found(format!("job {id} not found"), &trace_id.0))?;
    authorize_job_owner(&record, &claims, None, &trace_id.0)?;
    Ok(Json(JobStateResponse {
        job_id: id,
        state: record.state.as_str().to_string(),
        record: Some(record),
    }))
}

/// SSE stream of `JobEvent`s. Since the JobManager does not yet expose a
/// streaming event channel, we poll the job state every second for up to 30s
/// and emit a snapshot event each tick. The stream ends after the job
/// reaches a terminal state or after 30 emissions.
pub async fn stream(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<JobStreamQuery>,
    headers: HeaderMap,
    Extension(claims): Extension<TokenClaims>,
) -> Result<axum::response::Response, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let manager = state.kernel.jobs.manager().clone();
    // Verify the job exists.
    let record = manager
        .get(&id)
        .await
        .ok_or_else(|| ApiError::not_found(format!("job {id} not found"), &trace_id.0))?;
    authorize_job_owner(&record, &claims, None, &trace_id.0)?;
    let stream_name = if query.stream.is_empty() {
        "stdout".to_string()
    } else {
        query.stream.clone()
    };
    if !matches!(stream_name.as_str(), "stdout" | "stderr") {
        return Err(ApiError::internal(
            "job stream must be stdout or stderr",
            &trace_id.0,
        ));
    }

    let resume_cursor = job_stream_resume_cursor(&query, &headers);
    let stream = async_stream::stream! {
        let mut ticks = 0u32;
        let mut cursor = resume_cursor;
        loop {
            ticks += 1;
            let record = manager.get(&id).await;
            match manager.output_since(&id, &stream_name, cursor).await {
                Ok(chunks) => {
                    for chunk in chunks {
                        cursor = chunk.end_cursor;
                        let payload = serde_json::json!({
                            "job_id": id,
                            "stream": chunk.stream,
                            "start_cursor": chunk.start_cursor,
                            "end_cursor": chunk.end_cursor,
                            "bytes": chunk.bytes,
                            "redacted": chunk.redacted,
                        });
                        yield Ok::<Event, Infallible>(Event::default().id(cursor.to_string()).event("job_output").data(payload.to_string()));
                    }
                }
                Err(JobError::OutputTruncated { available_from, .. }) => {
                    let payload = serde_json::json!({
                        "job_id": id,
                        "stream": stream_name,
                        "requested_cursor": cursor,
                        "available_from": available_from,
                        "continuation_required": true,
                    });
                    yield Ok::<Event, Infallible>(Event::default().id(available_from.to_string()).event("output_truncated").data(payload.to_string()));
                    break;
                }
                Err(error) => {
                    let payload = serde_json::json!({
                        "job_id": id,
                        "stream": stream_name,
                        "error": error.to_string(),
                    });
                    yield Ok::<Event, Infallible>(Event::default().id(cursor.to_string()).event("job_error").data(payload.to_string()));
                    break;
                }
            }
            let payload = match &record {
                Some(r) => serde_json::json!({
                    "job_id": id,
                    "state": r.state.as_str(),
                    "tick": ticks,
                    "started_at": r.started_at,
                    "settled_at": r.settled_at,
                    "stdout_cursor": r.stdout_cursor,
                    "stderr_cursor": r.stderr_cursor,
                    "termination_receipt": r.termination_receipt,
                }),
                None => serde_json::json!({"job_id": id, "state": "unknown", "tick": ticks}),
            };
            yield Ok::<Event, Infallible>(Event::default().id(cursor.to_string()).event("job_state").data(payload.to_string()));
            if matches!(record.map(|r| r.state), Some(JobState::Exited | JobState::Lost)) {
                yield Ok(Event::default().id(cursor.to_string()).event("terminal").data("{\"final\":true}"));
                break;
            }
            if ticks >= 30 {
                yield Ok(Event::default().id(cursor.to_string()).event("timeout").data("{\"final\":true}"));
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    };

    Ok(Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response())
}

#[derive(Debug, Default, Deserialize)]
pub struct JobStreamQuery {
    #[serde(default)]
    pub cursor: Option<u64>,
    #[serde(default)]
    pub stream: String,
}

fn job_stream_resume_cursor(query: &JobStreamQuery, headers: &HeaderMap) -> u64 {
    query.cursor.unwrap_or_else(|| {
        headers
            .get("last-event-id")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0)
    })
}

#[cfg(test)]
mod tests {
    use super::{job_stream_resume_cursor, JobStreamQuery};
    use axum::http::{HeaderMap, HeaderValue};

    #[test]
    fn standard_last_event_id_resumes_the_byte_cursor() {
        let mut headers = HeaderMap::new();
        headers.insert("last-event-id", HeaderValue::from_static("42"));
        let from_header = JobStreamQuery {
            cursor: None,
            stream: "stdout".to_string(),
        };
        assert_eq!(job_stream_resume_cursor(&from_header, &headers), 42);

        let explicit_query = JobStreamQuery {
            cursor: Some(7),
            stream: "stdout".to_string(),
        };
        assert_eq!(job_stream_resume_cursor(&explicit_query, &headers), 7);
    }
}

#[derive(Debug, Deserialize)]
pub struct JobInputRequest {
    #[serde(flatten)]
    pub envelope: Envelope,
    #[serde(default)]
    pub input: String,
    #[serde(default)]
    pub lease_token: String,
}

pub async fn input(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Extension(claims): Extension<TokenClaims>,
    body: axum::body::Bytes,
) -> Result<Json<JobStateResponse>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let req: JobInputRequest =
        serde_json::from_slice(&body).map_err(|e| json_error(e, &trace_id.0))?;
    let manager = state.kernel.jobs.manager().clone();
    let record = manager
        .get(&id)
        .await
        .ok_or_else(|| ApiError::not_found(format!("job {id} not found"), &trace_id.0))?;
    authorize_job_owner(
        &record,
        &claims,
        Some(&req.envelope.request_context.task_id),
        &trace_id.0,
    )?;
    let state_now = if req.lease_token.is_empty() {
        manager.input(&id, req.input.as_bytes()).await
    } else {
        manager
            .input_with_lease(&id, &req.lease_token, req.input.as_bytes())
            .await
    }
    .map_err(|error| ApiError::internal(format!("job input: {error}"), &trace_id.0))?;
    let record = manager.get(&id).await;
    Ok(Json(JobStateResponse {
        job_id: id,
        state: state_now.as_str().to_string(),
        record,
    }))
}

#[derive(Debug, Deserialize)]
pub struct JobSignalRequest {
    #[serde(flatten)]
    pub envelope: Envelope,
    #[serde(default)]
    pub signal: String,
    #[serde(default)]
    pub lease_token: String,
}

pub async fn signal(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Extension(claims): Extension<TokenClaims>,
    body: axum::body::Bytes,
) -> Result<Json<JobStateResponse>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let req: JobSignalRequest =
        serde_json::from_slice(&body).map_err(|e| json_error(e, &trace_id.0))?;
    let manager = state.kernel.jobs.manager().clone();
    let record = manager
        .get(&id)
        .await
        .ok_or_else(|| ApiError::not_found(format!("job {id} not found"), &trace_id.0))?;
    authorize_job_owner(
        &record,
        &claims,
        Some(&req.envelope.request_context.task_id),
        &trace_id.0,
    )?;
    let state_now = if req.lease_token.is_empty() {
        manager.signal(&id, &req.signal).await
    } else {
        manager
            .signal_with_lease(&id, &req.lease_token, &req.signal)
            .await
    }
    .map_err(|error| ApiError::internal(format!("job signal: {error}"), &trace_id.0))?;
    let record = manager.get(&id).await;
    Ok(Json(JobStateResponse {
        job_id: id,
        state: state_now.as_str().to_string(),
        record,
    }))
}

#[derive(Debug, Deserialize)]
pub struct JobStopRequest {
    #[serde(flatten)]
    pub envelope: Envelope,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub lease_token: String,
}

pub async fn stop(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Extension(claims): Extension<TokenClaims>,
    body: axum::body::Bytes,
) -> Result<Json<JobStateResponse>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let req: JobStopRequest =
        serde_json::from_slice(&body).map_err(|e| json_error(e, &trace_id.0))?;
    let reason = if req.reason.is_empty() {
        "stopped"
    } else {
        &req.reason
    };
    let manager = state.kernel.jobs.manager().clone();
    let record = manager
        .get(&id)
        .await
        .ok_or_else(|| ApiError::not_found(format!("job {id} not found"), &trace_id.0))?;
    authorize_job_owner(
        &record,
        &claims,
        Some(&req.envelope.request_context.task_id),
        &trace_id.0,
    )?;
    let final_state = if req.lease_token.is_empty() {
        manager.stop(&id, reason).await
    } else {
        manager.stop_with_lease(&id, &req.lease_token, reason).await
    }
    .map_err(|e| ApiError::internal(format!("job stop: {e}"), &trace_id.0))?;
    let record = manager.get(&id).await;
    Ok(Json(JobStateResponse {
        job_id: id,
        state: final_state.as_str().to_string(),
        record,
    }))
}

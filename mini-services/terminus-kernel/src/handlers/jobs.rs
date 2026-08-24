//! JobService — `POST /v1/jobs/start`, `GET /v1/jobs/:id/stream` (SSE),
//! `POST /v1/jobs/:id/input`, `POST /v1/jobs/:id/signal`,
//! `POST /v1/jobs/:id/stop`, `GET /v1/jobs/:id`.

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Extension, Path, Query, State};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};
use terminus_jobs::{JobRecord, JobState};
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
            while let Some(event) = receiver.recv().await {
                if let Err(error) = manager
                    .record_event_with_lease(&event_job_id, &lease_token, &event)
                    .await
                {
                    tracing::error!(job_id = %event_job_id, %error, "durable job event persistence failed");
                    break;
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

pub async fn get(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<JobStateResponse>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let manager = state.kernel.jobs.manager().clone();
    let record = manager
        .get(&id)
        .await
        .ok_or_else(|| ApiError::not_found(format!("job {id} not found"), &trace_id.0))?;
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
) -> Result<axum::response::Response, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let manager = state.kernel.jobs.manager().clone();
    // Verify the job exists.
    if manager.get(&id).await.is_none() {
        return Err(ApiError::not_found(
            format!("job {id} not found"),
            &trace_id.0,
        ));
    }
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

    let stream = async_stream::stream! {
        let mut ticks = 0u32;
        let mut cursor = query.cursor;
        loop {
            ticks += 1;
            let record = manager.get(&id).await;
            if let Ok(chunks) = manager.output_since(&id, &stream_name, cursor).await {
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
                    yield Ok::<Event, Infallible>(Event::default().event("job_output").data(payload.to_string()));
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
            yield Ok::<Event, Infallible>(Event::default().event("job_state").data(payload.to_string()));
            if matches!(record.map(|r| r.state), Some(JobState::Exited | JobState::Lost)) {
                yield Ok(Event::default().event("terminal").data("{\"final\":true}"));
                break;
            }
            if ticks >= 30 {
                yield Ok(Event::default().event("timeout").data("{\"final\":true}"));
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
    pub cursor: u64,
    #[serde(default)]
    pub stream: String,
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
    body: axum::body::Bytes,
) -> Result<Json<JobStateResponse>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let req: JobInputRequest =
        serde_json::from_slice(&body).map_err(|e| json_error(e, &trace_id.0))?;
    let manager = state.kernel.jobs.manager().clone();
    if manager.get(&id).await.is_none() {
        return Err(ApiError::not_found(
            format!("job {id} not found"),
            &trace_id.0,
        ));
    }
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
    body: axum::body::Bytes,
) -> Result<Json<JobStateResponse>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let req: JobSignalRequest =
        serde_json::from_slice(&body).map_err(|e| json_error(e, &trace_id.0))?;
    let manager = state.kernel.jobs.manager().clone();
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

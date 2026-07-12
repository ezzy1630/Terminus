//! PolicyService — `POST /v1/policy/evaluate`.

use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use terminus_policy::{DecisionReport, NormalizedCommand};
use serde::Deserialize;

use crate::api::Envelope;
use crate::error::{json_error, ApiError};
use crate::state::AppState;
use crate::trace_id::TraceId;

#[derive(Debug, Deserialize)]
pub struct EvaluateRequest {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub command: NormalizedCommand,
}

pub async fn evaluate(
    State(state): State<Arc<AppState>>,
    body: axum::body::Bytes,
) -> Result<Json<DecisionReport>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let req: EvaluateRequest =
        serde_json::from_slice(&body).map_err(|e| json_error(e, &trace_id.0))?;
    let report = state.kernel.policies.evaluate(
        &req.envelope.request_context,
        &req.envelope.effect_intent,
        &req.command,
    );
    Ok(Json(report))
}

//! Governed browser computer-use boundary (ADR-0041).
//!
//! The public HTTP shape is present so clients can integrate against the
//! durable protocol. This build deliberately has no trusted browser adapter:
//! after capability and request validation both endpoints return the typed
//! `sandbox_unavailable` error. They never launch a browser, open a socket, or
//! manufacture observation/action receipts.

use std::sync::Arc;

use axum::extract::State;
use axum::Extension;
use axum::Json;
use serde::Deserialize;

use crate::api::Envelope;
use crate::auth::ValidatedCapabilityToken;
use crate::error::{json_error, ApiError};
use crate::state::AppState;
use crate::trace_id::TraceId;
use terminus_authz::{OperationClass, Scope};
use terminus_kernel::computer_use::{
    validate_action_request, validate_observe_request, BrowserActionKind,
};

#[derive(Debug, Deserialize)]
pub struct ObserveRequest {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub browser_session_id: String,
    pub viewport_width: u32,
    pub viewport_height: u32,
    pub max_screenshot_bytes: u64,
}

#[derive(Debug, Deserialize)]
pub struct ActRequest {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub browser_session_id: String,
    pub observation_id: String,
    pub observation_version: u64,
    pub action: String,
    #[serde(default)]
    pub target_id: String,
    #[serde(default)]
    pub navigation_url: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub scroll_x: f64,
    #[serde(default)]
    pub scroll_y: f64,
    #[serde(default)]
    pub wait_ms: u64,
}

pub async fn observe(
    State(state): State<Arc<AppState>>,
    Extension(capability): Extension<ValidatedCapabilityToken>,
    body: axum::body::Bytes,
) -> Result<Json<serde_json::Value>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let mut request: ObserveRequest =
        serde_json::from_slice(&body).map_err(|error| json_error(error, &trace_id.0))?;
    request.envelope.inject_capability_token(&capability);
    validate_capability(&state, &request.envelope, &trace_id)?;
    validate_observe_request(
        &request.browser_session_id,
        request.viewport_width,
        request.viewport_height,
        request.max_screenshot_bytes,
    )
    .map_err(|error| ApiError::validation(error.to_string(), &trace_id.0))?;
    Err(unavailable(&trace_id.0))
}

pub async fn act(
    State(state): State<Arc<AppState>>,
    Extension(capability): Extension<ValidatedCapabilityToken>,
    body: axum::body::Bytes,
) -> Result<Json<serde_json::Value>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let mut request: ActRequest =
        serde_json::from_slice(&body).map_err(|error| json_error(error, &trace_id.0))?;
    request.envelope.inject_capability_token(&capability);
    validate_capability(&state, &request.envelope, &trace_id)?;
    let action = parse_action(&request.action)
        .ok_or_else(|| ApiError::validation("action is not in the governed browser allowlist", &trace_id.0))?;
    validate_action_request(
        &request.browser_session_id,
        &request.observation_id,
        request.observation_version,
        action,
        &request.target_id,
        &request.navigation_url,
        &request.text,
        request.scroll_x,
        request.scroll_y,
        request.wait_ms,
    )
    .map_err(|error| ApiError::validation(error.to_string(), &trace_id.0))?;
    Err(unavailable(&trace_id.0))
}

fn validate_capability(
    state: &AppState,
    envelope: &Envelope,
    trace_id: &TraceId,
) -> Result<(), ApiError> {
    terminus_kernel::validate_capability_for_op(
        &state.token_issuer,
        &envelope.request_context,
        OperationClass::ComputerUse,
        &Scope::default(),
    )
    .map(|_| ())
    .map_err(|error| ApiError::from_kernel(error, &trace_id.0))
}

fn parse_action(action: &str) -> Option<BrowserActionKind> {
    match action {
        "navigate" => Some(BrowserActionKind::Navigate),
        "click" => Some(BrowserActionKind::Click),
        "type_text" => Some(BrowserActionKind::TypeText),
        "scroll" => Some(BrowserActionKind::Scroll),
        "wait" => Some(BrowserActionKind::Wait),
        _ => None,
    }
}

fn unavailable(trace_id: &str) -> ApiError {
    ApiError::new(
        terminus_kernel_protocol::ErrorCode::SandboxUnavailable,
        terminus_kernel_protocol::ErrorCategory::SandboxUnavailable,
        "no authenticated isolated-browser adapter is configured; no browser effect was attempted",
        trace_id,
    )
    .with_details(serde_json::json!({
        "capability": "computer_use",
        "execution_support": "unavailable",
        "receipts": "none",
        "required_adapter": "kernel-owned browser runtime with proxy-bound egress and durable receipt verification",
    }))
    .with_suggested_action("configure and security-review a kernel browser adapter before enabling computer use")
}


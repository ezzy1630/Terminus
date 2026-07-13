//! SecretService — `POST /v1/secrets/request`, `POST /v1/secrets/audit`,
//! and `POST /v1/secrets/redact`.
//!
//! The kernel's `SecretService::request` returns a `SecretHandle` whose
//! value MUST NOT be returned to the caller. We return only the metadata
//! (provider, scope, issued/expires, redaction patterns, allowed
//! destinations) — never the raw value.

use std::sync::Arc;

use axum::extract::State;
use axum::Extension;
use axum::Json;
use serde::{Deserialize, Serialize};
use terminus_secrets::{Redactor, SecretMetadata};

use crate::api::Envelope;
use crate::auth::ValidatedCapabilityToken;
use crate::error::{json_error, ApiError};
use crate::state::AppState;
use crate::trace_id::TraceId;

#[derive(Debug, Deserialize)]
pub struct SecretRequest {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub uri: String,
    #[serde(default)]
    pub requested_by: String,
}

#[derive(Debug, Serialize)]
pub struct SecretRequestResponse {
    pub handle_ref: String,
    pub metadata: SecretMetadata,
    /// The raw secret value is NEVER included. The control plane injects
    /// it directly into a child process via the kernel; the model only sees
    /// the handle reference.
    pub redacted: bool,
}

pub async fn request(
    State(state): State<Arc<AppState>>,
    Extension(cap_token): Extension<ValidatedCapabilityToken>,
    body: axum::body::Bytes,
) -> Result<Json<SecretRequestResponse>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let mut req: SecretRequest =
        serde_json::from_slice(&body).map_err(|e| json_error(e, &trace_id.0))?;
    req.envelope.inject_capability_token(&cap_token);
    let requested_by = if req.requested_by.is_empty() {
        req.envelope.request_context.actor_id.clone()
    } else {
        req.requested_by
    };
    // §31.3 step 3: the kernel validates the capability token's `Secret`
    // operation class + secret-URI scope. We call the kernel's
    // `SecretService::request` (which validates) instead of the broker
    // directly so the token is enforced.
    state
        .kernel
        .secrets
        .request(
            &req.envelope.request_context,
            &req.envelope.effect_intent,
            &req.uri,
            &requested_by,
        )
        .map_err(|e| ApiError::from_kernel(e, &trace_id.0))?;
    // The kernel's SecretService::request returned Ok(()) — it has validated
    // capability and recorded the audit event. We still fetch a handle from
    // the broker so we can return metadata to the caller (the value is
    // never serialized).
    let handle = state
        .kernel
        .secrets
        .broker()
        .request(&req.uri, &requested_by)
        .map_err(|e| {
            ApiError::new(
                terminus_kernel_protocol::ErrorCode::PermissionDenied,
                terminus_kernel_protocol::ErrorCategory::Permission,
                format!("{e}"),
                &trace_id.0,
            )
        })?;
    let handle_ref = format!(
        "terminus-secret-handle:{}",
        terminus_kernel_protocol::new_id()
    );
    let metadata = handle.metadata.clone();
    drop(handle); // wipes the value
    Ok(Json(SecretRequestResponse {
        handle_ref,
        metadata,
        redacted: true,
    }))
}

#[derive(Debug, Deserialize)]
pub struct AuditRequest {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub uri: String,
    #[serde(default)]
    pub requested_by: String,
    #[serde(default)]
    pub action: String,
}

#[derive(Debug, Serialize)]
pub struct AuditResponse {
    pub recorded: bool,
    pub total_entries: usize,
}

pub async fn audit(
    State(state): State<Arc<AppState>>,
    body: axum::body::Bytes,
) -> Result<Json<AuditResponse>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let req: AuditRequest =
        serde_json::from_slice(&body).map_err(|e| json_error(e, &trace_id.0))?;
    let broker = state.kernel.secrets.broker();
    let log = broker.audit_log();
    // The audit log's `record_use` requires a full `SecretMetadata`. We
    // synthesise a minimal one for the dev mini-service so the entry is
    // attributable without re-fetching the secret.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let metadata = SecretMetadata {
        uri: req.uri.clone(),
        provider: "audit".to_string(),
        scope: req.action.clone(),
        issued_at_unix: now,
        expires_at_unix: now + 3600,
        redaction_patterns: Vec::new(),
        allowed_destinations: Vec::new(),
    };
    log.record_use(&req.uri, &req.requested_by, &metadata);
    Ok(Json(AuditResponse {
        recorded: true,
        total_entries: log.entries().len(),
    }))
}

#[derive(Debug, Deserialize)]
pub struct RedactRequest {
    #[serde(flatten)]
    pub envelope: Envelope,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub patterns: Vec<RedactPatternIn>,
}

#[derive(Debug, Deserialize)]
pub struct RedactPatternIn {
    pub id: String,
    pub literal: String,
}

#[derive(Debug, Serialize)]
pub struct RedactResponse {
    pub redacted_text: String,
    pub redaction_count: usize,
}

pub async fn redact(
    State(_state): State<Arc<AppState>>,
    body: axum::body::Bytes,
) -> Result<Json<RedactResponse>, ApiError> {
    let trace_id = TraceId::new(uuid::Uuid::now_v7().to_string());
    let req: RedactRequest =
        serde_json::from_slice(&body).map_err(|e| json_error(e, &trace_id.0))?;
    let mut redactor = Redactor::new();
    for p in req.patterns {
        redactor.add_literal(p.id, p.literal);
    }
    let (redacted_bytes, count) = redactor.redact(req.text.as_bytes());
    let redacted_text = String::from_utf8_lossy(&redacted_bytes).to_string();
    Ok(Json(RedactResponse {
        redacted_text,
        redaction_count: count,
    }))
}

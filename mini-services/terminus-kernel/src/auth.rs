//! Auth middleware — validates the static `Authorization: Bearer <token>`
//! header and, for mutating endpoints, the `x-capability-token` header.

use axum::extract::Request;
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::Response;
use std::sync::Arc;
use terminus_authz::{OperationClass, TokenClaims};

use crate::error::ApiError;
use crate::state::AppState;
use crate::trace_id::TraceId;

/// A typed extension carrying the validated capability-token string. Set by
/// `require_capability_for_path` after the token has been signature/expiry/
/// audience/operation-class checked. Mutating handlers read this extension
/// and inject it into the envelope's `request_context.capability_token`
/// before calling the kernel, so the kernel's own §31.3 step-3 capability
/// validation can re-verify the token against the requested operation.
#[derive(Debug, Clone)]
pub struct ValidatedCapabilityToken(pub String);

/// Validate the bearer token from the `Authorization` header. Always
/// required for every request.
pub async fn require_bearer(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    req: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let trace_id = TraceId::from_request_or_new(&req).to_string();
    let auth = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok());
    let bearer = match auth {
        Some(s) if s.starts_with("Bearer ") => &s["Bearer ".len()..],
        _ => {
            return Err(ApiError::new(
                terminus_kernel_protocol::ErrorCode::CapabilityTokenInvalid,
                terminus_kernel_protocol::ErrorCategory::Permission,
                "missing or malformed Authorization header (expected `Bearer <token>`)",
                trace_id,
            ));
        }
    };
    if bearer != state.bearer_token {
        return Err(ApiError::new(
            terminus_kernel_protocol::ErrorCode::CapabilityTokenInvalid,
            terminus_kernel_protocol::ErrorCategory::Permission,
            "invalid bearer token",
            trace_id,
        ));
    }
    let mut req = req;
    req.extensions_mut().insert(TraceId::new(trace_id));
    Ok(next.run(req).await)
}

/// For mutating endpoints, validate the `x-capability-token` header against
/// the kernel's `TokenIssuer`. The required `OperationClass` is derived
/// from the request path.
pub async fn require_capability_for_path(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    req: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let trace_id = TraceId::from_request_or_new(&req).to_string();
    let required_op = match required_operation_class(req.method(), req.uri().path()) {
        Some(op) => op,
        None => {
            // No capability required for this path; pass through.
            let mut req = req;
            req.extensions_mut().insert(TraceId::new(trace_id));
            return Ok(next.run(req).await);
        }
    };
    let token_str = req
        .headers()
        .get("x-capability-token")
        .and_then(|h| h.to_str().ok());
    let token_str = match token_str {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => {
            return Err(ApiError::new(
                terminus_kernel_protocol::ErrorCode::CapabilityTokenInvalid,
                terminus_kernel_protocol::ErrorCategory::Permission,
                "missing x-capability-token header",
                trace_id,
            )
            .with_suggested_action(
                "use the dev capability token logged at kernel startup or mint a new one via the control plane",
            ));
        }
    };
    let token = match state.token_issuer.validate(&token_str) {
        Ok(t) => t,
        Err(e) => {
            let code = match e {
                terminus_authz::AuthzError::Expired => {
                    terminus_kernel_protocol::ErrorCode::CapabilityTokenExpired
                }
                terminus_authz::AuthzError::Revoked => {
                    terminus_kernel_protocol::ErrorCode::CapabilityTokenRevoked
                }
                _ => terminus_kernel_protocol::ErrorCode::CapabilityTokenInvalid,
            };
            return Err(ApiError::new(
                code,
                terminus_kernel_protocol::ErrorCategory::Permission,
                format!("capability token rejected: {e}"),
                trace_id,
            ));
        }
    };
    if !token
        .claims
        .operation_classes
        .iter()
        .any(|op| *op == required_op || *op == OperationClass::Admin)
    {
        return Err(ApiError::new(
            terminus_kernel_protocol::ErrorCode::PermissionDenied,
            terminus_kernel_protocol::ErrorCategory::Permission,
            format!(
                "capability token does not grant operation class `{:?}`",
                required_op
            ),
            trace_id,
        ));
    }
    let mut req = req;
    req.extensions_mut().insert(TraceId::new(trace_id.clone()));
    req.extensions_mut()
        .insert(TokenClaims::clone(&token.claims));
    req.extensions_mut()
        .insert(ValidatedCapabilityToken(token_str));
    Ok(next.run(req).await)
}

/// Map a (method, path) pair to the `OperationClass` required to invoke
/// it. Returns `None` for read-only endpoints that only require the bearer
/// token (e.g. `POST /v1/info`, `GET /v1/health`).
fn required_operation_class(method: &axum::http::Method, path: &str) -> Option<OperationClass> {
    use axum::http::Method;
    // Only POST routes are mutating in this API; GET routes are read-only.
    if method != Method::POST {
        return None;
    }
    // Read-only POST routes that don't require a capability token.
    if matches!(path, "/v1/info" | "/v1/health") {
        return None;
    }
    let op = if path.starts_with("/v1/workspaces") || path.starts_with("/v1/files") {
        OperationClass::Read
    } else if path.starts_with("/v1/patch") {
        OperationClass::Patch
    } else if path.starts_with("/v1/process") {
        OperationClass::Exec
    } else if path.starts_with("/v1/jobs") {
        OperationClass::Job
    } else if path.starts_with("/v1/sandbox/select") {
        OperationClass::Sandbox
    } else if path.starts_with("/v1/policy") {
        OperationClass::Policy
    } else if path.starts_with("/v1/secrets") {
        OperationClass::Secret
    } else if path.starts_with("/v1/network/request") {
        OperationClass::Network
    } else if path.starts_with("/v1/code-intel") {
        OperationClass::CodeIntel
    } else if path.starts_with("/v1/extensions") {
        OperationClass::Extension
    } else if path.starts_with("/v1/artifacts/ingest") || path.starts_with("/v1/artifacts/gc") {
        OperationClass::ArtifactIngest
    } else {
        return None;
    };
    Some(op)
}

/// Add CORS headers to all responses. Allow-all for development; the Caddy
/// gateway handles production.
pub async fn cors_layer(req: Request, next: Next) -> Response {
    let method = req.method().clone();
    let mut resp = next.run(req).await;
    let headers = resp.headers_mut();
    headers.insert(
        axum::http::header::ACCESS_CONTROL_ALLOW_ORIGIN,
        axum::http::HeaderValue::from_static("*"),
    );
    headers.insert(
        axum::http::header::ACCESS_CONTROL_ALLOW_METHODS,
        axum::http::HeaderValue::from_static("GET, POST, PUT, PATCH, DELETE, OPTIONS"),
    );
    headers.insert(
        axum::http::header::ACCESS_CONTROL_ALLOW_HEADERS,
        axum::http::HeaderValue::from_static(
            "Authorization, Content-Type, x-capability-token, x-idempotency-key, x-trace-id, traceparent, X-Transform-Port",
        ),
    );
    headers.insert(
        axum::http::header::ACCESS_CONTROL_EXPOSE_HEADERS,
        axum::http::HeaderValue::from_static("x-trace-id, x-request-id"),
    );
    if method == axum::http::Method::OPTIONS {
        *resp.status_mut() = StatusCode::NO_CONTENT;
    }
    resp
}

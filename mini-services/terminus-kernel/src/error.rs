//! SPEC §30.4 error envelope. Maps kernel errors and HTTP-layer errors to
//! the structured `{ error: { code, message, retryable, category, details,
//! suggested_action, trace_id } }` envelope with appropriate HTTP status
//! codes.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use terminus_kernel_protocol::{ErrorCategory, ErrorCode, KernelError};
use serde_json::json;

/// A structured API error that serializes to the SPEC §30.4 envelope.
#[derive(Debug, Clone)]
pub struct ApiError {
    pub code: ErrorCode,
    pub category: ErrorCategory,
    pub message: String,
    pub retryable: bool,
    pub details: serde_json::Value,
    pub suggested_action: Option<String>,
    pub trace_id: String,
}

impl ApiError {
    pub fn new(
        code: ErrorCode,
        category: ErrorCategory,
        message: impl Into<String>,
        trace_id: impl Into<String>,
    ) -> Self {
        Self {
            code,
            category,
            message: message.into(),
            retryable: code.retryable(),
            details: serde_json::Value::Null,
            suggested_action: None,
            trace_id: trace_id.into(),
        }
    }

    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = details;
        self
    }

    pub fn with_suggested_action(mut self, action: impl Into<String>) -> Self {
        self.suggested_action = Some(action.into());
        self
    }

    /// Map a `KernelError` to an `ApiError`, preserving all structured
    /// fields. The HTTP status code is derived from the category.
    pub fn from_kernel(err: KernelError, trace_id: impl Into<String>) -> Self {
        let trace_id = trace_id.into();
        match err {
            KernelError::Structured {
                code,
                message,
                category,
                retryable,
                details,
                suggested_action,
                trace_id: existing,
            } => Self {
                code,
                category,
                message,
                retryable,
                details,
                suggested_action,
                trace_id: if existing.is_some() {
                    existing.unwrap_or_else(|| trace_id.clone())
                } else {
                    trace_id
                },
            },
        }
    }

    pub fn validation(msg: impl Into<String>, trace_id: impl Into<String>) -> Self {
        Self::new(
            ErrorCode::InvalidArgument,
            ErrorCategory::Validation,
            msg,
            trace_id,
        )
    }

    pub fn not_found(msg: impl Into<String>, trace_id: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, ErrorCategory::NotFound, msg, trace_id)
    }

    pub fn internal(msg: impl Into<String>, trace_id: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, ErrorCategory::Internal, msg, trace_id)
    }

    pub fn unauthorized(msg: impl Into<String>, trace_id: impl Into<String>) -> Self {
        Self::new(
            ErrorCode::CapabilityTokenInvalid,
            ErrorCategory::Permission,
            msg,
            trace_id,
        )
    }

    pub fn permission_denied(msg: impl Into<String>, trace_id: impl Into<String>) -> Self {
        Self::new(
            ErrorCode::PermissionDenied,
            ErrorCategory::Permission,
            msg,
            trace_id,
        )
    }

    /// Map the error category to an HTTP status code (SPEC §30.4 mapping).
    pub fn status_code(&self) -> StatusCode {
        match self.category {
            ErrorCategory::Validation => StatusCode::BAD_REQUEST,
            ErrorCategory::NotFound => StatusCode::NOT_FOUND,
            ErrorCategory::Conflict => StatusCode::CONFLICT,
            ErrorCategory::Permission => StatusCode::FORBIDDEN,
            ErrorCategory::PolicyDenied => StatusCode::FORBIDDEN,
            ErrorCategory::ApprovalRequired => StatusCode::FORBIDDEN,
            ErrorCategory::SandboxUnavailable => StatusCode::SERVICE_UNAVAILABLE,
            ErrorCategory::ResourceExhausted => StatusCode::TOO_MANY_REQUESTS,
            ErrorCategory::BudgetExhausted => StatusCode::PAYMENT_REQUIRED,
            ErrorCategory::Timeout => StatusCode::GATEWAY_TIMEOUT,
            // 499 is nginx's "client closed request" — not in hyper's
            // typed StatusCode; we fall back to GONE (410) which best
            // captures "the resource is gone and will not come back".
            ErrorCategory::Cancelled => StatusCode::GONE,
            ErrorCategory::Provider => StatusCode::BAD_GATEWAY,
            ErrorCategory::ExternalDependency => StatusCode::BAD_GATEWAY,
            ErrorCategory::Integrity => StatusCode::INTERNAL_SERVER_ERROR,
            ErrorCategory::Internal => StatusCode::INTERNAL_SERVER_ERROR,
            ErrorCategory::UnknownSettlement => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = self.status_code();
        // SPEC §30.4 envelope.
        let body = json!({
            "error": {
                "code": format!("{:?}", self.code),
                "message": self.message,
                "retryable": self.retryable,
                "category": self.category.as_str(),
                "details": self.details,
                "suggested_action": self.suggested_action,
                "trace_id": self.trace_id,
            }
        });
        (status, Json(body)).into_response()
    }
}

/// Build an `ApiError` from a serde JSON parse failure, tagged with the
/// request's `trace_id`.
pub fn json_error(err: serde_json::Error, trace_id: &str) -> ApiError {
    ApiError::validation(format!("invalid JSON body: {err}"), trace_id)
}

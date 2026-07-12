//! Stable error codes and categories (SPEC.md Section 30.4).
//!
//! These cover the required categories:
//! validation, not_found, conflict, permission, policy_denied, approval_required,
//! sandbox_unavailable, resource_exhausted, budget_exhausted, timeout, cancelled,
//! provider, external_dependency, integrity, internal, unknown_settlement.

use serde::{Deserialize, Serialize};

/// Required error categories from SPEC.md Section 30.4.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCategory {
    Validation,
    NotFound,
    Conflict,
    Permission,
    PolicyDenied,
    ApprovalRequired,
    SandboxUnavailable,
    ResourceExhausted,
    BudgetExhausted,
    Timeout,
    Cancelled,
    Provider,
    ExternalDependency,
    Integrity,
    Internal,
    UnknownSettlement,
}

impl ErrorCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Validation => "validation",
            Self::NotFound => "not_found",
            Self::Conflict => "conflict",
            Self::Permission => "permission",
            Self::PolicyDenied => "policy_denied",
            Self::ApprovalRequired => "approval_required",
            Self::SandboxUnavailable => "sandbox_unavailable",
            Self::ResourceExhausted => "resource_exhausted",
            Self::BudgetExhausted => "budget_exhausted",
            Self::Timeout => "timeout",
            Self::Cancelled => "cancelled",
            Self::Provider => "provider",
            Self::ExternalDependency => "external_dependency",
            Self::Integrity => "integrity",
            Self::Internal => "internal",
            Self::UnknownSettlement => "unknown_settlement",
        }
    }
}

/// Stable error code. Codes are part of the public API and MUST NOT be reused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[allow(non_camel_case_types)]
pub enum ErrorCode {
    // validation / general
    InvalidRequest,
    InvalidArgument,
    MissingField,
    SchemaMismatch,
    // not_found
    NotFound,
    WorkspaceNotFound,
    JobNotFound,
    ProcessNotFound,
    ArtifactNotFound,
    PathNotFound,
    // conflict
    StaleSourceVersion,
    AlreadyExists,
    TransactionConflict,
    LeaseHeld,
    // permission / policy / approval
    PermissionDenied,
    CapabilityTokenInvalid,
    CapabilityTokenExpired,
    CapabilityTokenRevoked,
    PolicyDenied,
    ApprovalRequired,
    ApprovalRejected,
    TaintedByUntrustedSource,
    // sandbox
    SandboxUnavailable,
    SandboxDegraded,
    UnsupportedPlatform,
    // resource / budget
    ResourceExhausted,
    BudgetExhausted,
    // timeout / cancellation
    Timeout,
    Cancelled,
    // integrity
    IntegrityCheckFailed,
    HashMismatch,
    // external
    ExternalDependencyFailed,
    ProviderError,
    // internal / settlement
    Internal,
    UnknownSettlement,
    NotImplemented,
}

impl ErrorCode {
    pub fn category(self) -> ErrorCategory {
        match self {
            Self::InvalidRequest
            | Self::InvalidArgument
            | Self::MissingField
            | Self::SchemaMismatch => ErrorCategory::Validation,
            Self::NotFound
            | Self::WorkspaceNotFound
            | Self::JobNotFound
            | Self::ProcessNotFound
            | Self::ArtifactNotFound
            | Self::PathNotFound => ErrorCategory::NotFound,
            Self::StaleSourceVersion
            | Self::AlreadyExists
            | Self::TransactionConflict
            | Self::LeaseHeld => ErrorCategory::Conflict,
            Self::PermissionDenied
            | Self::CapabilityTokenInvalid
            | Self::CapabilityTokenExpired
            | Self::CapabilityTokenRevoked => ErrorCategory::Permission,
            Self::PolicyDenied | Self::TaintedByUntrustedSource => ErrorCategory::PolicyDenied,
            Self::ApprovalRequired | Self::ApprovalRejected => ErrorCategory::ApprovalRequired,
            Self::SandboxUnavailable | Self::SandboxDegraded | Self::UnsupportedPlatform => {
                ErrorCategory::SandboxUnavailable
            }
            Self::ResourceExhausted => ErrorCategory::ResourceExhausted,
            Self::BudgetExhausted => ErrorCategory::BudgetExhausted,
            Self::Timeout => ErrorCategory::Timeout,
            Self::Cancelled => ErrorCategory::Cancelled,
            Self::ExternalDependencyFailed => ErrorCategory::ExternalDependency,
            Self::ProviderError => ErrorCategory::Provider,
            Self::IntegrityCheckFailed | Self::HashMismatch => ErrorCategory::Integrity,
            Self::Internal | Self::NotImplemented => ErrorCategory::Internal,
            Self::UnknownSettlement => ErrorCategory::UnknownSettlement,
        }
    }

    pub fn retryable(self) -> bool {
        matches!(
            self,
            Self::StaleSourceVersion
                | Self::Timeout
                | Self::ExternalDependencyFailed
                | Self::ResourceExhausted
                | Self::SandboxUnavailable
        )
    }
}

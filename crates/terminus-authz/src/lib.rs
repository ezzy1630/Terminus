//! Capability tokens (SPEC.md Section 31.6).
//!
//! A capability token is:
//! - short lived;
//! - audience restricted to one kernel instance;
//! - bound to principal, session, task, workspace, operation classes, and
//!   maximum scope;
//! - nonce protected;
//! - revocable;
//! - never available to model-visible text or child processes.
//!
//! The token is HMAC-SHA256 signed with a kernel-held secret. The signature
//! covers the canonical JSON encoding of the token claims. The raw signing
//! key is NEVER serialized.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]
#![forbid(unsafe_code)]

mod error;
mod token;

pub use error::AuthzError;
pub use token::{
    workspace_path_matches, CapabilityToken, OperationClass, RevocationList, Scope, TokenBinder,
    TokenClaims, TokenIssuer, TokenRevoker,
};

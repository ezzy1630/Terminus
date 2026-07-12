//! Secret broker (SPEC.md Section 13.6).
//!
//! The broker:
//! - obtains a short-lived credential for a `secret://provider/scope` URI;
//! - injects it into one isolated process env/fd only;
//! - constrains destination and operation;
//! - redacts matching output;
//! - records the use in an audit log;
//! - revokes afterward.
//!
//! The model never receives the raw secret.

#![forbid(unsafe_code)]

mod audit;
mod broker;
mod error;
mod redact;

pub use audit::{AuditEntry, SecretAuditLog};
pub use broker::{SecretBroker, SecretHandle, SecretMetadata};
pub use error::SecretError;
pub use redact::{RedactionPattern, Redactor};

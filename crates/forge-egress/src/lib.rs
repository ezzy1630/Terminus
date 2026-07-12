//! Egress proxy with destination allowlist and private-IP denial
//! (SPEC.md Section 13.3, 27.3).
//!
//! `EgressProxy` resolves a destination host, checks it against an allowlist
//! and a private/link-local denial list, and enforces per-task byte and rate
//! limits. The actual TCP relay is a stub that respects the allowlist; no
//! real TLS interception is performed.

#![forbid(unsafe_code)]

mod error;
mod policy;
mod proxy;

pub use error::EgressError;
pub use policy::{DestinationPolicy, EgressPolicy};
pub use proxy::{EgressProxy, RateLimit};

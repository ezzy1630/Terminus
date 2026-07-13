//! Egress proxy with destination allowlist and private-IP denial
//! (SPEC.md Section 13.3, 27.3).
//!
//! `EgressProxy` resolves a destination host, checks it against an allowlist
//! and a private/link-local denial list, and enforces per-task byte and rate
//! limits. On Unix, [`EgressBroker`] exposes an authenticated-by-socket
//! broker route for sandboxed payloads: it resolves and connects only after
//! policy authorization, then relays opaque bytes without TLS interception.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]
#![forbid(unsafe_code)]

#[cfg(unix)]
mod broker;
mod error;
mod policy;
mod proxy;

#[cfg(unix)]
pub use broker::{EgressBroker, EgressBrokerRequest, EgressBrokerResponse};
pub use error::EgressError;
pub use policy::{DestinationPolicy, EgressPolicy};
pub use proxy::{EgressProxy, RateLimit};

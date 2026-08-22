//! L7 connector broker (ADR-0035 §2, SPEC §17.2/§17.3, §18.1/§18.2).
//!
//! Credentialed external operations are performed HERE, inside the trusted
//! boundary:
//!
//! 1. a [`ConnectorGrant`] proves the caller is authorized for ONE exact
//!    operation (connector + destination + method/path class + task +
//!    effect);
//! 2. the grant is consumed atomically — replay is impossible;
//! 3. the credential is resolved via the secret broker and injected into
//!    the outgoing request; it never reaches models, tools, or artifacts;
//! 4. every connection passes the L4 egress broker first
//!    ([`terminus_egress::EgressProxy`] stays the lower layer);
//! 5. responses are scanned so credential material echoed back is redacted;
//! 6. a typed [`ConnectorReceipt`] records hashes and outcome — no secret
//!    material.
//!
//! TLS: this build executes `http` destinations only and fails closed with
//! [`ConnectorError::TlsUnavailable`] for `https` rather than sending
//! credentials in plaintext. A validated TLS transport is a follow-up and
//! will be conformance-tested before any https connector is declared.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]
#![forbid(unsafe_code)]

mod broker;
mod error;
mod operation;
mod receipt;

pub use broker::{AuthStyle, ConnectorBroker, ConnectorBrokerBuilder};
pub use error::ConnectorError;
pub use operation::{path_matches_class, CanonicalOperation};
pub use receipt::{ConnectorReceipt, Outcome};

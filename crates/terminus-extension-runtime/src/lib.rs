//! WASI extension runtime (stub) — SPEC.md Section 35.
//!
//! This build does not link a WASI runtime. The host reports "WASI runtime
//! not available" and validates manifests only. Real WASM execution is a
//! future task (M9).

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]
#![forbid(unsafe_code)]

mod error;
mod host;
mod manifest;

pub use error::ExtensionError;
pub use host::{WasiExtensionHost, WasiExtensionHostReport};
pub use manifest::{ExtensionManifest, ExtensionTrustLevel};

pub use terminus_kernel_protocol::WorkspacePath;

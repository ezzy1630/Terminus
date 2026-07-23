//! WASI / process extension runtime — SPEC.md Section 35.
//!
//! Process-isolated host always available. WASI execution requires a
//! `wasmtime` binary on PATH and fails closed otherwise. Never silently
//! executes native in-process code.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]
#![forbid(unsafe_code)]

mod error;
mod host;
mod manifest;
mod process_host;

pub use error::ExtensionError;
pub use host::{WasiExtensionHost, WasiExtensionHostReport, WasiExtensionLimits};
pub use manifest::{ExtensionManifest, ExtensionTrustLevel};
pub use process_host::{
    ExtensionInvokeRequest, ExtensionInvokeResponse, ProcessExtensionHost, ProcessExtensionLimits,
};

pub use terminus_kernel_protocol::WorkspacePath;

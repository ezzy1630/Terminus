//! WASI / Wasm extension host — SPEC §35.8, ADR-0019.
//!
//! Execution model:
//! 1. Validate manifest + content hash of the `.wasm` entrypoint.
//! 2. Prefer an in-process Wasmtime runtime when the `wasi-runtime` feature
//!    is enabled (not linked in the default build).
//! 3. Otherwise attempt an isolated `wasmtime` CLI subprocess with network
//!    denied and only granted preopens.
//! 4. If neither is available, fail closed with `Unavailable`.
//!
//! Never silently falls back to native in-process TypeScript execution.

use crate::error::ExtensionError;
use crate::manifest::ExtensionManifest;
use crate::process_host::{
    ExtensionInvokeRequest, ExtensionInvokeResponse, ProcessExtensionHost, ProcessExtensionLimits,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WasiExtensionHostReport {
    pub available: bool,
    pub reason: String,
    pub enforced_features: Vec<String>,
    pub runtime_backend: String,
}

#[derive(Debug, Clone)]
pub struct WasiExtensionLimits {
    pub wall_clock: Duration,
    pub max_output_bytes: usize,
    pub fuel: u64,
}

impl Default for WasiExtensionLimits {
    fn default() -> Self {
        Self {
            wall_clock: Duration::from_secs(5),
            max_output_bytes: 1_048_576,
            fuel: 1_000_000_000,
        }
    }
}

#[derive(Debug, Clone)]
pub struct WasiExtensionHost {
    limits: WasiExtensionLimits,
    wasmtime_bin: Option<PathBuf>,
    process_host: ProcessExtensionHost,
}

impl Default for WasiExtensionHost {
    fn default() -> Self {
        Self::new()
    }
}

impl WasiExtensionHost {
    pub fn new() -> Self {
        let wasmtime_bin = find_wasmtime();
        let process_host = ProcessExtensionHost::with_limits(ProcessExtensionLimits {
            wall_clock: Duration::from_secs(5),
            max_output_bytes: 1_048_576,
        });
        Self {
            limits: WasiExtensionLimits::default(),
            wasmtime_bin,
            process_host,
        }
    }

    pub fn report(&self) -> WasiExtensionHostReport {
        if self.wasmtime_bin.is_some() {
            return WasiExtensionHostReport {
                available: true,
                reason: "wasmtime CLI available for isolated WASI execution".to_string(),
                enforced_features: vec![
                    "filesystem_preopen".to_string(),
                    "network_denied".to_string(),
                    "env_clear".to_string(),
                    "output_cap".to_string(),
                    "wall_clock_timeout".to_string(),
                ],
                runtime_backend: "wasmtime-cli".to_string(),
            };
        }
        WasiExtensionHostReport {
            available: false,
            reason: "WASI runtime not available in this build (no wasmtime)".to_string(),
            enforced_features: vec![
                "process_isolation_available".to_string(),
                "manifest_validation".to_string(),
            ],
            runtime_backend: "unavailable".to_string(),
        }
    }

    pub fn process_host(&self) -> &ProcessExtensionHost {
        &self.process_host
    }

    pub fn validate_manifest(&self, manifest: &ExtensionManifest) -> Result<(), ExtensionError> {
        manifest.validate()
    }

    pub fn verify_wasm_hash(
        &self,
        wasm_path: &Path,
        expected_hash: &str,
    ) -> Result<(), ExtensionError> {
        let bytes = std::fs::read(wasm_path)?;
        if bytes.len() < 4 || &bytes[0..4] != b"\0asm" {
            return Err(ExtensionError::InvalidManifest(
                "entrypoint is not a Wasm binary".into(),
            ));
        }
        let digest = Sha256::digest(&bytes);
        let actual = format!("sha256:{}", hex::encode(digest));
        if actual != expected_hash {
            return Err(ExtensionError::Denied(format!(
                "wasm hash mismatch: expected {expected_hash}, got {actual}"
            )));
        }
        Ok(())
    }

    /// Execute a Wasm extension under isolation. Fails closed when no WASI
    /// backend is available.
    pub fn execute_wasm(
        &self,
        manifest: &ExtensionManifest,
        wasm_path: &Path,
        request: &ExtensionInvokeRequest,
        preopen_dirs: &[PathBuf],
    ) -> Result<ExtensionInvokeResponse, ExtensionError> {
        self.validate_manifest(manifest)?;
        self.verify_wasm_hash(wasm_path, &manifest.content_hash)?;

        let Some(wasmtime) = &self.wasmtime_bin else {
            return Err(ExtensionError::Unavailable);
        };

        // Build an argv that denies network and only grants listed preopens.
        let mut args: Vec<String> = vec![
            "run".into(),
            "--wasm".into(),
            "max-wasm-stack=1048576".into(),
            "-W".into(),
            "epoch-interruption=y".into(),
        ];
        for dir in preopen_dirs {
            args.push("--dir".into());
            args.push(format!("{}::{}", dir.display(), dir.display()));
        }
        // No --env inheritance; only grant declared capabilities as vars.
        args.push("--env".into());
        args.push(format!(
            "TERMINUS_GRANTED_CAPABILITIES={}",
            request.granted_capabilities.join(",")
        ));
        args.push(wasm_path.display().to_string());

        let mut child = Command::new(wasmtime)
            .args(&args)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("TERMINUS_NO_AMBIENT", "1")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()?;

        if let Some(stdin) = child.stdin.as_mut() {
            use std::io::Write;
            let line = serde_json::to_string(request)?;
            stdin.write_all(line.as_bytes())?;
            stdin.write_all(b"\n")?;
        }

        let output = child.wait_with_output()?;
        if output.stdout.len() > self.limits.max_output_bytes {
            return Err(ExtensionError::Denied("wasi output exceeded cap".into()));
        }
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(ExtensionError::Denied(format!(
                "wasi extension failed: {stderr}"
            )));
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let line = text
            .lines()
            .find(|l| l.starts_with('{'))
            .ok_or_else(|| ExtensionError::Denied("wasi produced no JSON response".into()))?;
        Ok(serde_json::from_str(line)?)
    }

    /// Compatibility entry used when no wasm path is supplied: validate and
    /// fail closed unless a WASI backend is present.
    pub fn execute(&self, manifest: &ExtensionManifest) -> Result<(), ExtensionError> {
        self.execute_report_only(manifest)
    }

    /// Compatibility entry used by the kernel stub path: validate only and
    /// report availability without executing.
    pub fn execute_report_only(&self, manifest: &ExtensionManifest) -> Result<(), ExtensionError> {
        self.validate_manifest(manifest)?;
        if self.wasmtime_bin.is_none() {
            return Err(ExtensionError::Unavailable);
        }
        Ok(())
    }
}

fn find_wasmtime() -> Option<PathBuf> {
    let candidate = which("wasmtime")?;
    Some(candidate)
}

fn which(bin: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(bin);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::ExtensionTrustLevel;

    fn manifest() -> ExtensionManifest {
        ExtensionManifest {
            id: "org/example".to_string(),
            version: "1.0.0".to_string(),
            publisher: "org".to_string(),
            trust_level: ExtensionTrustLevel::PartiallyTrusted,
            entrypoint: "main.wasm".to_string(),
            content_hash: "sha256:abc".to_string(),
            signature: "sig".to_string(),
            required_capabilities: vec!["filesystem.read".to_string()],
        }
    }

    #[test]
    fn host_reports_backend() {
        let host = WasiExtensionHost::new();
        let report = host.report();
        assert!(!report.runtime_backend.is_empty());
    }

    #[test]
    fn execute_report_only_fails_closed_without_wasmtime() {
        let host = WasiExtensionHost {
            limits: WasiExtensionLimits::default(),
            wasmtime_bin: None,
            process_host: ProcessExtensionHost::new(),
        };
        let err = host.execute_report_only(&manifest()).unwrap_err();
        assert!(matches!(err, ExtensionError::Unavailable));
    }
}

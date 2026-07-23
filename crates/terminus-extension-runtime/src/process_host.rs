//! Isolated process extension host — SPEC §35.8.
//!
//! Third-party extensions run as subprocesses with cleared environment and
//! only explicitly granted capability variables. No ambient authority.

use crate::error::ExtensionError;
use crate::manifest::ExtensionManifest;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtensionInvokeRequest {
    pub operation: String,
    pub input_json: String,
    pub granted_capabilities: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtensionInvokeResponse {
    pub ok: bool,
    pub outcome_kind: String,
    pub payload_json: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ProcessExtensionLimits {
    pub wall_clock: Duration,
    pub max_output_bytes: usize,
}

impl Default for ProcessExtensionLimits {
    fn default() -> Self {
        Self {
            wall_clock: Duration::from_secs(5),
            max_output_bytes: 1_048_576,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ProcessExtensionHost {
    limits: ProcessExtensionLimits,
}

impl ProcessExtensionHost {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_limits(limits: ProcessExtensionLimits) -> Self {
        Self { limits }
    }

    /// Verify entrypoint bytes match the manifest content hash (`sha256:<hex>`).
    pub fn verify_entrypoint_hash(
        &self,
        entrypoint: &Path,
        expected_hash: &str,
    ) -> Result<(), ExtensionError> {
        let bytes = std::fs::read(entrypoint)?;
        let digest = Sha256::digest(&bytes);
        let actual = format!("sha256:{}", hex::encode(digest));
        if actual != expected_hash {
            return Err(ExtensionError::Denied(format!(
                "entrypoint hash mismatch: expected {expected_hash}, got {actual}"
            )));
        }
        Ok(())
    }

    /// Execute an isolated extension process. Environment is cleared; only
    /// grant variables and a minimal PATH are provided.
    pub fn execute(
        &self,
        manifest: &ExtensionManifest,
        entrypoint: &Path,
        request: &ExtensionInvokeRequest,
    ) -> Result<ExtensionInvokeResponse, ExtensionError> {
        manifest.validate()?;
        self.verify_entrypoint_hash(entrypoint, &manifest.content_hash)?;

        // Deny ambient authority: no inherited env, no host secrets.
        let mut child = Command::new(entrypoint)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("TERMINUS_NO_AMBIENT", "1")
            .env("TERMINUS_EXTENSION_ID", &manifest.id)
            .env("TERMINUS_EXTENSION_VERSION", &manifest.version)
            .env(
                "TERMINUS_GRANTED_CAPABILITIES",
                request.granted_capabilities.join(","),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        {
            let Some(stdin) = child.stdin.as_mut() else {
                return Err(ExtensionError::Denied("stdin unavailable".into()));
            };
            let line = serde_json::to_string(request)?;
            stdin.write_all(line.as_bytes())?;
            stdin.write_all(b"\n")?;
        }

        let timeout = self.limits.wall_clock;
        let start = std::time::Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_status)) => break,
                Ok(None) => {
                    if start.elapsed() > timeout {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(ExtensionError::Denied(format!(
                            "extension timed out after {}ms",
                            timeout.as_millis()
                        )));
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(e) => return Err(ExtensionError::Io(e)),
            }
        }

        let mut stdout = Vec::new();
        if let Some(mut out) = child.stdout.take() {
            let _ = out.read_to_end(&mut stdout);
        }
        if stdout.len() > self.limits.max_output_bytes {
            return Err(ExtensionError::Denied(format!(
                "extension output exceeded {} bytes",
                self.limits.max_output_bytes
            )));
        }

        let text = String::from_utf8_lossy(&stdout);
        let line = text
            .lines()
            .find(|l| l.starts_with('{'))
            .ok_or_else(|| ExtensionError::Denied("extension produced no JSON response".into()))?;
        let response: ExtensionInvokeResponse = serde_json::from_str(line)?;
        Ok(response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::{ExtensionManifest, ExtensionTrustLevel};
    use std::io::Write;

    fn write_temp_script(body: &str) -> tempfile::NamedTempFile {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            f.write_all(body.as_bytes()).unwrap();
            let mut perms = f.as_file().metadata().unwrap().permissions();
            perms.set_mode(0o755);
            f.as_file().set_permissions(perms).unwrap();
        }
        #[cfg(not(unix))]
        {
            f.write_all(body.as_bytes()).unwrap();
        }
        f
    }

    #[test]
    fn hash_mismatch_denied() {
        let host = ProcessExtensionHost::new();
        let script = write_temp_script("#!/bin/sh\necho '{}'\n");
        let manifest = ExtensionManifest {
            id: "ext".into(),
            version: "1.0.0".into(),
            publisher: "t".into(),
            trust_level: ExtensionTrustLevel::Untrusted,
            entrypoint: script.path().display().to_string(),
            content_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
                .into(),
            signature: String::new(),
            required_capabilities: vec![],
        };
        let err = host
            .verify_entrypoint_hash(script.path(), &manifest.content_hash)
            .unwrap_err();
        assert!(matches!(err, ExtensionError::Denied(_)));
    }
}

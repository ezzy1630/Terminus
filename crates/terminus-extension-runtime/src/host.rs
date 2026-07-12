use crate::error::ExtensionError;
use crate::manifest::ExtensionManifest;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WasiExtensionHostReport {
    pub available: bool,
    pub reason: String,
    pub enforced_features: Vec<String>,
}

/// A stub WASI host. Reports unavailable in this build.
#[derive(Debug, Clone, Default)]
pub struct WasiExtensionHost {
    available: bool,
}

impl WasiExtensionHost {
    pub fn new() -> Self {
        Self { available: false }
    }

    pub fn report(&self) -> WasiExtensionHostReport {
        if self.available {
            return WasiExtensionHostReport {
                available: true,
                reason: "WASI runtime available".to_string(),
                enforced_features: vec![
                    "filesystem".to_string(),
                    "network".to_string(),
                    "secrets".to_string(),
                ],
            };
        }
        WasiExtensionHostReport {
            available: false,
            reason: "WASI runtime not available in this build".to_string(),
            enforced_features: Vec::new(),
        }
    }

    /// Validate a manifest without executing it.
    pub fn validate_manifest(&self, manifest: &ExtensionManifest) -> Result<(), ExtensionError> {
        manifest.validate()?;
        if !self.available {
            // Validation passes; we just won't be able to execute.
        }
        Ok(())
    }

    /// Execute the extension. In this stub build, always returns
    /// `Unavailable`.
    pub fn execute(&self, _manifest: &ExtensionManifest) -> Result<(), ExtensionError> {
        Err(ExtensionError::Unavailable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::{ExtensionManifest, ExtensionTrustLevel};

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
    fn host_reports_unavailable_by_default() {
        let host = WasiExtensionHost::new();
        let report = host.report();
        assert!(!report.available);
        assert!(report.reason.contains("not available"));
    }

    #[test]
    fn manifest_validation_passes() {
        let host = WasiExtensionHost::new();
        host.validate_manifest(&manifest()).unwrap();
    }

    #[test]
    fn manifest_validation_rejects_empty_id() {
        let host = WasiExtensionHost::new();
        let mut m = manifest();
        m.id = String::new();
        let err = host.validate_manifest(&m).unwrap_err();
        assert!(matches!(err, ExtensionError::InvalidManifest(_)));
    }

    #[test]
    fn execute_fails_closed_when_unavailable() {
        let host = WasiExtensionHost::new();
        let err = host.execute(&manifest()).unwrap_err();
        assert!(matches!(err, ExtensionError::Unavailable));
    }
}

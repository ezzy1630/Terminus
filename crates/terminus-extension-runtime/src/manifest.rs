use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExtensionTrustLevel {
    FirstParty,
    PartiallyTrusted,
    Untrusted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtensionManifest {
    pub id: String,
    pub version: String,
    pub publisher: String,
    pub trust_level: ExtensionTrustLevel,
    pub entrypoint: String,
    pub content_hash: String,
    pub signature: String,
    pub required_capabilities: Vec<String>,
}

impl ExtensionManifest {
    /// Validate the manifest structurally. Does NOT verify the signature
    /// against a key — that requires a verifier wired in by the host.
    pub fn validate(&self) -> Result<(), super::ExtensionError> {
        if self.id.is_empty() {
            return Err(super::ExtensionError::InvalidManifest("id is empty".into()));
        }
        if self.version.is_empty() {
            return Err(super::ExtensionError::InvalidManifest(
                "version is empty".into(),
            ));
        }
        if self.entrypoint.is_empty() {
            return Err(super::ExtensionError::InvalidManifest(
                "entrypoint is empty".into(),
            ));
        }
        if self.content_hash.is_empty() {
            return Err(super::ExtensionError::InvalidManifest(
                "content_hash is empty".into(),
            ));
        }
        Ok(())
    }
}

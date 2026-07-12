//! Artifact metadata (SPEC.md Section 29.3).

use crate::error::ArtifactError;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RetentionClass {
    Ephemeral,
    Session,
    Audit,
    Evidence,
    MemorySource,
    LegalHold,
}

impl Default for RetentionClass {
    fn default() -> Self {
        Self::Session
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RedactionStatus {
    NotRequired,
    Applied,
    Rejected,
    Pending,
}

impl Default for RedactionStatus {
    fn default() -> Self {
        Self::NotRequired
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Confidentiality {
    Public,
    Workspace,
    SecretAdjacent,
    Secret,
}

impl Default for Confidentiality {
    fn default() -> Self {
        Self::Workspace
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrustLabel {
    Trusted,
    Derived,
    Untrusted,
}

impl Default for TrustLabel {
    fn default() -> Self {
        Self::Derived
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ContentEncoding {
    Identity,
    Zstd,
}

impl Default for ContentEncoding {
    fn default() -> Self {
        Self::Identity
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ArtifactMetadata {
    pub hash: String,
    pub size_bytes: u64,
    pub media_type: String,
    pub content_encoding: ContentEncoding,
    pub created_at: String,
    pub producer: String,
    pub confidentiality: Confidentiality,
    pub trust: TrustLabel,
    pub retention_class: RetentionClass,
    pub redaction_status: RedactionStatus,
    pub source_uri: String,
    pub source_version: String,
}

impl ArtifactMetadata {
    pub fn new(hash: impl Into<String>, size_bytes: u64, media_type: impl Into<String>) -> Self {
        Self {
            hash: hash.into(),
            size_bytes,
            media_type: media_type.into(),
            content_encoding: ContentEncoding::Identity,
            created_at: now_rfc3339(),
            producer: String::new(),
            confidentiality: Confidentiality::Workspace,
            trust: TrustLabel::Derived,
            retention_class: RetentionClass::Session,
            redaction_status: RedactionStatus::NotRequired,
            source_uri: String::new(),
            source_version: String::new(),
        }
    }

    pub fn to_json(&self) -> Result<String, ArtifactError> {
        Ok(serde_json::to_string(self)?)
    }

    pub fn from_json(s: &str) -> Result<Self, ArtifactError> {
        Ok(serde_json::from_str(s)?)
    }
}

fn now_rfc3339() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}.{:06}+00:00", dur.as_secs(), dur.subsec_micros())
}

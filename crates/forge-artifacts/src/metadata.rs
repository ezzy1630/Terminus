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

impl RetentionClass {
    pub fn as_db_str(self) -> &'static str {
        match self {
            Self::Ephemeral => "ephemeral",
            Self::Session => "session",
            Self::Audit => "audit",
            Self::Evidence => "evidence",
            Self::MemorySource => "memory_source",
            Self::LegalHold => "legal_hold",
        }
    }

    pub fn from_db_str(s: &str) -> Self {
        match s {
            "ephemeral" => Self::Ephemeral,
            "audit" => Self::Audit,
            "evidence" => Self::Evidence,
            "memory_source" => Self::MemorySource,
            "legal_hold" => Self::LegalHold,
            _ => Self::Session,
        }
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

impl RedactionStatus {
    pub fn as_db_str(self) -> &'static str {
        match self {
            Self::NotRequired => "not_required",
            Self::Applied => "applied",
            Self::Rejected => "rejected",
            Self::Pending => "pending",
        }
    }

    pub fn from_db_str(s: &str) -> Self {
        match s {
            "applied" => Self::Applied,
            "rejected" => Self::Rejected,
            "pending" => Self::Pending,
            _ => Self::NotRequired,
        }
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

impl Confidentiality {
    pub fn as_db_str(self) -> &'static str {
        match self {
            Self::Public => "public",
            Self::Workspace => "workspace",
            Self::SecretAdjacent => "secret_adjacent",
            Self::Secret => "secret",
        }
    }

    pub fn from_db_str(s: &str) -> Self {
        match s {
            "public" => Self::Public,
            "secret_adjacent" => Self::SecretAdjacent,
            "secret" => Self::Secret,
            _ => Self::Workspace,
        }
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

impl TrustLabel {
    pub fn as_db_str(self) -> &'static str {
        match self {
            Self::Trusted => "trusted",
            Self::Derived => "derived",
            Self::Untrusted => "untrusted",
        }
    }

    pub fn from_db_str(s: &str) -> Self {
        match s {
            "trusted" => Self::Trusted,
            "untrusted" => Self::Untrusted,
            _ => Self::Derived,
        }
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

impl ContentEncoding {
    pub fn as_db_str(&self) -> &'static str {
        match self {
            Self::Identity => "identity",
            Self::Zstd => "zstd",
        }
    }

    pub fn from_db_str(s: &str) -> Self {
        match s {
            "zstd" => Self::Zstd,
            _ => Self::Identity,
        }
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

/// A row in the `artifact_links` table. Links an artifact to an owning
/// entity (turn, task, tool_call, verification_result, etc.) by purpose.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactLink {
    pub id: String,
    pub artifact_hash: String,
    pub owner_type: String,
    pub owner_id: String,
    pub purpose: String,
    pub created_at: String,
}

fn now_rfc3339() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}.{:06}+00:00", dur.as_secs(), dur.subsec_micros())
}

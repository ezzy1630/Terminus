use crate::broker::SecretMetadata;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

/// A single audit entry — never contains the secret value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditEntry {
    pub uri: String,
    pub requested_by: String,
    pub issued_at_unix: u64,
    pub expires_at_unix: u64,
    pub allowed_destinations: Vec<String>,
}

#[derive(Debug, Default)]
pub struct SecretAuditLog {
    entries: Mutex<Vec<AuditEntry>>,
}

impl SecretAuditLog {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record_use(&self, uri: &str, requested_by: &str, metadata: &SecretMetadata) {
        let entry = AuditEntry {
            uri: uri.to_string(),
            requested_by: requested_by.to_string(),
            issued_at_unix: metadata.issued_at_unix,
            expires_at_unix: metadata.expires_at_unix,
            allowed_destinations: metadata.allowed_destinations.clone(),
        };
        if let Ok(mut g) = self.entries.lock() {
            g.push(entry);
        }
    }

    pub fn entries(&self) -> Vec<AuditEntry> {
        match self.entries.lock() {
            Ok(g) => g.clone(),
            Err(p) => p.into_inner().clone(),
        }
    }
}

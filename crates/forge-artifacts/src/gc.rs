//! Reference-aware, dry-run-capable garbage collection (SPEC.md Section 29.4).

use crate::error::ArtifactError;
use crate::metadata::RetentionClass;
use crate::store::ArtifactStore;
use std::collections::HashSet;

/// A live reference to an artifact by hex hash.
#[derive(Debug, Clone)]
pub struct GcReference {
    pub hex_hash: String,
    pub holder: String,
    pub retention_class: RetentionClass,
}

/// A dry-run GC report.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GcDryRunReport {
    pub scanned: usize,
    pub referenced: usize,
    pub collectable: Vec<String>,
    pub retained: Vec<String>,
}

/// An actual GC result.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GcReport {
    pub dry_run: GcDryRunReport,
    pub deleted: Vec<String>,
    pub errors: Vec<String>,
}

impl ArtifactStore {
    /// Walk the store and return which artifacts would be collected.
    /// `live` is the set of currently referenced hex hashes (without
    /// `sha256:` prefix). Artifacts on `legal_hold` retention are never
    /// collectable.
    pub fn gc_dry_run(&self, live: &HashSet<String>) -> Result<GcDryRunReport, ArtifactError> {
        let hashes = self.list_hex_hashes();
        let mut collectable = Vec::new();
        let mut retained = Vec::new();
        for hex in &hashes {
            if live.contains(hex) {
                retained.push(hex.clone());
                continue;
            }
            // Check retention class — never collect legal_hold.
            let metadata = self.metadata(&format!("sha256:{hex}")).unwrap_or_else(|_| {
                crate::metadata::ArtifactMetadata::new(
                    format!("sha256:{hex}"),
                    0,
                    "application/octet-stream",
                )
            });
            if matches!(metadata.retention_class, RetentionClass::LegalHold) {
                retained.push(hex.clone());
            } else {
                collectable.push(hex.clone());
            }
        }
        Ok(GcDryRunReport {
            scanned: hashes.len(),
            referenced: retained.len(),
            collectable,
            retained,
        })
    }

    /// Actually collect unreferenced artifacts. Always runs a dry-run first.
    pub fn gc_collect(&self, live: &HashSet<String>) -> Result<GcReport, ArtifactError> {
        let dry_run = self.gc_dry_run(live)?;
        let mut deleted = Vec::new();
        let mut errors = Vec::new();
        for hex in &dry_run.collectable {
            match self.delete(hex) {
                Ok(()) => deleted.push(hex.clone()),
                Err(e) => errors.push(format!("{hex}: {e}")),
            }
        }
        Ok(GcReport {
            dry_run,
            deleted,
            errors,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::ArtifactStore;
    use tempfile::tempdir;

    fn hash_hex(hash: &str) -> String {
        hash.strip_prefix("sha256:").unwrap_or(hash).to_string()
    }

    #[test]
    fn gc_dry_run_marks_unreferenced() {
        let dir = tempdir().unwrap();
        let store = ArtifactStore::open(dir.path()).unwrap();
        let (_, a) = store.ingest(b"kept").unwrap();
        let (_, b) = store.ingest(b"dead").unwrap();
        let mut live = HashSet::new();
        live.insert(hash_hex(&a.sha256));
        let report = store.gc_dry_run(&live).unwrap();
        assert_eq!(report.scanned, 2);
        assert_eq!(report.referenced, 1);
        assert_eq!(report.collectable.len(), 1);
        assert!(report.collectable.contains(&hash_hex(&b.sha256)));
    }

    #[test]
    fn gc_collect_deletes_unreferenced() {
        let dir = tempdir().unwrap();
        let store = ArtifactStore::open(dir.path()).unwrap();
        let (_, a) = store.ingest(b"kept").unwrap();
        let (_, b) = store.ingest(b"dead").unwrap();
        let mut live = HashSet::new();
        live.insert(hash_hex(&a.sha256));
        let result = store.gc_collect(&live).unwrap();
        assert_eq!(result.deleted.len(), 1);
        assert!(store.exists(&a.sha256));
        assert!(!store.exists(&b.sha256));
    }

    #[test]
    fn gc_never_deletes_legal_hold() {
        let dir = tempdir().unwrap();
        let store = ArtifactStore::open(dir.path()).unwrap();
        let (mut meta, a) = store.ingest(b"locked").unwrap();
        meta.retention_class = RetentionClass::LegalHold;
        let hex = hash_hex(&a.sha256);
        // Re-write metadata with retention=legal_hold.
        let metadata_path = store.root().join("metadata").join(format!("{hex}.json"));
        std::fs::write(&metadata_path, serde_json::to_string(&meta).unwrap()).unwrap();
        let live = HashSet::new();
        let report = store.gc_dry_run(&live).unwrap();
        assert!(report.collectable.is_empty());
        assert!(report.retained.contains(&hex));
    }
}

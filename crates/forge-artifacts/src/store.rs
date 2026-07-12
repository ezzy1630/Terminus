use crate::error::ArtifactError;
use crate::metadata::ArtifactMetadata;
use crate::sqlite::SqliteMetadataStore;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

/// Content-addressed artifact store.
///
/// The store roots at `$FORGE_DATA/artifacts/` (or any directory passed to
/// `open`). Files are laid out as `sha256/ab/cd/<hash>`, metadata lives in
/// a SQLite database at `metadata.db` (primary) with a JSON sidecar at
/// `metadata/<hash>.json` (fallback). Temp files live under `tmp/` and are
/// renamed atomically into place.
///
/// The store is `Send + Sync` because the underlying SQLite connection is
/// guarded by a `Mutex` shared via `Arc`. Cloning is cheap.
#[derive(Clone)]
pub struct ArtifactStore {
    root: PathBuf,
    max_bytes: u64,
    sqlite: SqliteMetadataStore,
}

impl std::fmt::Debug for ArtifactStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ArtifactStore")
            .field("root", &self.root.display().to_string())
            .field("max_bytes", &self.max_bytes)
            .finish_non_exhaustive()
    }
}

impl ArtifactStore {
    /// Open or create a store rooted at `root`. Creates the CAS directories
    /// and the SQLite metadata database at `<root>/metadata.db`.
    pub fn open(root: impl Into<PathBuf>) -> Result<Self, ArtifactError> {
        let root = root.into();
        for sub in ["sha256", "metadata", "tmp", "quarantine"] {
            fs::create_dir_all(root.join(sub))?;
        }
        let sqlite = SqliteMetadataStore::open(&root.join("metadata.db"))?;
        Ok(Self {
            root,
            max_bytes: 4 * 1024 * 1024 * 1024, // 4 GiB default ceiling
            sqlite,
        })
    }

    pub fn with_max_bytes(mut self, max: u64) -> Self {
        self.max_bytes = max;
        self
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Direct accessor for the SQLite metadata store. Used by GC and by
    /// callers that want to add or query `artifact_links` rows.
    pub fn sqlite(&self) -> &SqliteMetadataStore {
        &self.sqlite
    }

    /// Ingest bytes into the store. Returns the artifact reference and
    /// metadata. If the artifact already exists, returns the existing
    /// metadata (re-ingest is idempotent). After the atomic rename + fsync,
    /// the metadata row is upserted into the SQLite database. The JSON
    /// sidecar is also written as a fallback.
    pub fn ingest(&self, bytes: &[u8]) -> Result<(ArtifactMetadata, forge_kernel_protocol::ArtifactRef), ArtifactError> {
        if bytes.len() as u64 > self.max_bytes {
            return Err(ArtifactError::TooLarge { max: self.max_bytes });
        }
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        let digest = hasher.finalize();
        let hash = format!("sha256:{}", hex::encode(digest));
        let hex_hash = &hash["sha256:".len()..];
        let cas_path = self.cas_path(hex_hash);
        let metadata_path = self.metadata_path(hex_hash);

        // If the SQLite row already exists, treat the ingest as idempotent
        // and return the existing metadata without touching the filesystem.
        // (The CAS blob is content-addressed so a re-write would be a no-op
        // anyway.)
        if let Some(existing) = self.sqlite.get(&hash)? {
            // Best-effort: ensure the JSON sidecar exists for tools that
            // cannot read SQLite. Ignore errors here — SQLite is primary.
            if !metadata_path.exists() {
                let _ = fs::write(&metadata_path, existing.to_json().unwrap_or_default());
            }
            let artifact_ref = forge_kernel_protocol::ArtifactRef::new(
                existing.hash.clone(),
                existing.size_bytes,
                existing.media_type.clone(),
            );
            return Ok((existing, artifact_ref));
        }

        if !cas_path.exists() {
            // Stream into a temp file then atomic rename.
            let tmp_path = self
                .root
                .join("tmp")
                .join(format!("ingest-{}-{hex_hash}", std::process::id()));
            {
                let mut file = File::create(&tmp_path)?;
                file.write_all(bytes)?;
                file.sync_all()?;
            }
            // Ensure parent dir exists.
            if let Some(parent) = cas_path.parent() {
                fs::create_dir_all(parent)?;
            }
            // Atomic rename — if target exists, just remove the temp.
            match fs::rename(&tmp_path, &cas_path) {
                Ok(()) => {
                    if let Some(parent) = cas_path.parent() {
                        if let Ok(dir) = fs::File::open(parent) {
                            let _ = dir.sync_all();
                        }
                    }
                }
                Err(_) => {
                    // Target may already exist (race); remove temp.
                    let _ = fs::remove_file(&tmp_path);
                }
            }
        }

        let media_type = infer_media_type(bytes);
        let mut metadata = ArtifactMetadata::new(hash.clone(), bytes.len() as u64, media_type);
        // Persist metadata if missing (JSON sidecar fallback).
        if !metadata_path.exists() {
            fs::write(&metadata_path, metadata.to_json()?)?;
        } else if let Ok(s) = fs::read_to_string(&metadata_path) {
            if let Ok(existing) = ArtifactMetadata::from_json(&s) {
                metadata = existing;
            }
        }
        // Upsert into SQLite (primary store).
        let storage_path = cas_path.to_string_lossy().to_string();
        self.sqlite.upsert(&metadata, &storage_path)?;

        let artifact_ref = forge_kernel_protocol::ArtifactRef::new(
            hash,
            bytes.len() as u64,
            metadata.media_type.clone(),
        );
        Ok((metadata, artifact_ref))
    }

    /// Retrieve the raw bytes for an artifact.
    pub fn get(&self, hash: &str) -> Result<Vec<u8>, ArtifactError> {
        let hex_hash = strip_sha256_prefix(hash)?;
        validate_hex_hash(hex_hash)?;
        let path = self.cas_path(hex_hash);
        if !path.exists() {
            return Err(ArtifactError::NotFound(hash.to_string()));
        }
        Ok(fs::read(&path)?)
    }

    /// Fetch metadata for an artifact. Reads from SQLite first (primary
    /// store); falls back to the JSON sidecar if SQLite has no row. If
    /// neither exists but the blob is present, derives minimal metadata.
    pub fn metadata(&self, hash: &str) -> Result<ArtifactMetadata, ArtifactError> {
        let hex_hash = strip_sha256_prefix(hash)?;
        validate_hex_hash(hex_hash)?;
        // Primary: SQLite.
        if let Some(meta) = self.sqlite.get(hash)? {
            return Ok(meta);
        }
        // Fallback: JSON sidecar.
        let path = self.metadata_path(hex_hash);
        if path.exists() {
            let s = fs::read_to_string(&path)?;
            if let Ok(meta) = ArtifactMetadata::from_json(&s) {
                // Backfill SQLite so subsequent reads are fast.
                let storage_path = self.cas_path(hex_hash).to_string_lossy().to_string();
                let _ = self.sqlite.upsert(&meta, &storage_path);
                return Ok(meta);
            }
        }
        // Last resort: derive minimal metadata from the blob itself.
        let blob = self.cas_path(hex_hash);
        if blob.exists() {
            let size = fs::metadata(&blob)?.len();
            let meta = ArtifactMetadata::new(hash.to_string(), size, "application/octet-stream");
            let storage_path = blob.to_string_lossy().to_string();
            let _ = self.sqlite.upsert(&meta, &storage_path);
            return Ok(meta);
        }
        Err(ArtifactError::NotFound(hash.to_string()))
    }

    /// Update the metadata for an existing artifact. Writes to BOTH the
    /// SQLite store (primary) and the JSON sidecar (fallback). Use this
    /// instead of writing the JSON sidecar directly so the two stores do
    /// not diverge.
    pub fn update_metadata(&self, meta: &ArtifactMetadata) -> Result<(), ArtifactError> {
        let hex_hash = strip_sha256_prefix(&meta.hash)?;
        validate_hex_hash(hex_hash)?;
        let storage_path = self.cas_path(hex_hash).to_string_lossy().to_string();
        self.sqlite.upsert(meta, &storage_path)?;
        let metadata_path = self.metadata_path(hex_hash);
        fs::write(&metadata_path, meta.to_json()?)?;
        Ok(())
    }

    /// Create a link between an artifact and an owning entity (task, turn,
    /// tool_call, verification_result, etc.) by purpose. Idempotent —
    /// inserting a duplicate `(hash, owner_type, owner_id, purpose)` tuple
    /// is silently ignored.
    pub fn link(
        &self,
        hash: &str,
        owner_type: &str,
        owner_id: &str,
        purpose: &str,
    ) -> Result<(), ArtifactError> {
        self.sqlite.link(hash, owner_type, owner_id, purpose)
    }

    /// List all artifact links for a given owner.
    pub fn list_by_owner(
        &self,
        owner_type: &str,
        owner_id: &str,
    ) -> Result<Vec<crate::metadata::ArtifactLink>, ArtifactError> {
        self.sqlite.list_by_owner(owner_type, owner_id)
    }

    /// Stream-copy an external file into the store. Useful for large outputs.
    pub fn ingest_file(&self, src: &Path) -> Result<(ArtifactMetadata, forge_kernel_protocol::ArtifactRef), ArtifactError> {
        let bytes = fs::read(src)?;
        self.ingest(&bytes)
    }

    /// True if the artifact exists in the store.
    pub fn exists(&self, hash: &str) -> bool {
        let Ok(hex) = strip_sha256_prefix(hash) else { return false; };
        self.cas_path(hex).exists()
    }

    /// Path helpers -------------------------------------------------------
    fn cas_path(&self, hex_hash: &str) -> PathBuf {
        let (a, b, rest) = split_hash(hex_hash);
        self.root.join("sha256").join(a).join(b).join(rest)
    }

    fn metadata_path(&self, hex_hash: &str) -> PathBuf {
        self.root.join("metadata").join(format!("{hex_hash}.json"))
    }

    /// Enumerate all known artifacts by hex hash.
    pub(crate) fn list_hex_hashes(&self) -> Vec<String> {
        let mut out = Vec::new();
        let sha_root = self.root.join("sha256");
        if let Ok(level1) = fs::read_dir(&sha_root) {
            for entry1 in level1.flatten() {
                if let Ok(level2) = fs::read_dir(entry1.path()) {
                    for entry2 in level2.flatten() {
                        if let Ok(files) = fs::read_dir(entry2.path()) {
                            for file in files.flatten() {
                                let name = file.file_name().to_string_lossy().to_string();
                                let parent1 = entry1.file_name().to_string_lossy().to_string();
                                let parent2 = entry2.file_name().to_string_lossy().to_string();
                                out.push(format!("{parent1}{parent2}{name}"));
                            }
                        }
                    }
                }
            }
        }
        out
    }

    /// Delete an artifact by hash. Used by GC after reference checks.
    pub(crate) fn delete(&self, hex_hash: &str) -> Result<(), ArtifactError> {
        let cas = self.cas_path(hex_hash);
        let meta = self.metadata_path(hex_hash);
        if cas.exists() {
            fs::remove_file(&cas)?;
        }
        if meta.exists() {
            fs::remove_file(&meta)?;
        }
        Ok(())
    }

    /// SQLite-backed GC dry run. Finds artifact hashes (with `sha256:`
    /// prefix) that have NO links and whose `retention_class` is NOT
    /// `legal_hold`. These are candidates for garbage collection.
    ///
    /// Unlike [`gc_dry_run`](crate::store::ArtifactStore::gc_dry_run),
    /// this method consults the SQLite `artifact_links` table rather than
    /// the caller-supplied `live` set. Both can be used together: the
    /// SQLite-based scan finds unlinked artifacts; the JSON-based scan
    /// cross-checks against an external live set.
    pub fn gc_dry_run_sqlite(&self) -> Result<Vec<String>, ArtifactError> {
        self.sqlite.gc_dry_run()
    }
}

fn split_hash(hex_hash: &str) -> (&str, &str, &str) {
    let bytes = hex_hash.as_bytes();
    let a = std::str::from_utf8(&bytes[..2]).unwrap_or("");
    let b = std::str::from_utf8(&bytes[2..4]).unwrap_or("");
    let rest = std::str::from_utf8(&bytes[4..]).unwrap_or("");
    (a, b, rest)
}

fn strip_sha256_prefix(hash: &str) -> Result<&str, ArtifactError> {
    Ok(if let Some(stripped) = hash.strip_prefix("sha256:") {
        stripped
    } else {
        hash
    })
}

fn validate_hex_hash(hex_hash: &str) -> Result<(), ArtifactError> {
    if hex_hash.len() != 64 || !hex_hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ArtifactError::InvalidHash(hex_hash.to_string()));
    }
    Ok(())
}

fn infer_media_type(bytes: &[u8]) -> String {
    if bytes.starts_with(b"%PDF") {
        return "application/pdf".to_string();
    }
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        return "image/png".to_string();
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return "image/jpeg".to_string();
    }
    if bytes.starts_with(b"\x1f\x8b") {
        return "application/gzip".to_string();
    }
    // Try UTF-8.
    if std::str::from_utf8(bytes).is_ok() {
        return "text/plain; charset=utf-8".to_string();
    }
    "application/octet-stream".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn open_store() -> (tempfile::TempDir, ArtifactStore) {
        let dir = tempdir().unwrap();
        let store = ArtifactStore::open(dir.path()).unwrap();
        (dir, store)
    }

    #[test]
    fn ingest_and_get_round_trip() {
        let (_dir, store) = open_store();
        let bytes = b"hello world";
        let (meta, art) = store.ingest(bytes).unwrap();
        assert!(meta.hash.starts_with("sha256:"));
        assert_eq!(meta.size_bytes, bytes.len() as u64);
        let got = store.get(&art.sha256).unwrap();
        assert_eq!(got, bytes);
    }

    #[test]
    fn ingest_is_idempotent() {
        let (_dir, store) = open_store();
        let bytes = b"deterministic content";
        let (m1, r1) = store.ingest(bytes).unwrap();
        let (m2, r2) = store.ingest(bytes).unwrap();
        assert_eq!(r1.sha256, r2.sha256);
        assert_eq!(m1.hash, m2.hash);
    }

    #[test]
    fn metadata_persists() {
        let (dir, store) = open_store();
        let bytes = b"persistent";
        let (_, art) = store.ingest(bytes).unwrap();
        drop(store);
        let store2 = ArtifactStore::open(dir.path()).unwrap();
        let meta = store2.metadata(&art.sha256).unwrap();
        assert_eq!(meta.size_bytes, bytes.len() as u64);
    }

    #[test]
    fn rejects_invalid_hash_on_get() {
        let (_dir, store) = open_store();
        let err = store.get("sha256:abc").unwrap_err();
        assert!(matches!(err, ArtifactError::InvalidHash(_)));
    }

    #[test]
    fn not_found_returns_typed_error() {
        let (_dir, store) = open_store();
        let err = store
            .get("sha256:0000000000000000000000000000000000000000000000000000000000000000")
            .unwrap_err();
        assert!(matches!(err, ArtifactError::NotFound(_)));
    }

    #[test]
    fn media_type_inferred() {
        let (_dir, store) = open_store();
        let (_, art) = store.ingest(b"%PDF-1.4 fake").unwrap();
        assert_eq!(art.media_type, "application/pdf");
        let (_, art) = store.ingest(b"plain text").unwrap();
        assert_eq!(art.media_type, "text/plain; charset=utf-8");
    }

    // ---------- SQLite-specific tests (SPEC §29.3 step 7-8) ----------

    #[test]
    fn ingest_writes_to_sqlite() {
        let (_dir, store) = open_store();
        let bytes = b"sqlite-persisted";
        let (meta, art) = store.ingest(bytes).unwrap();
        // The SQLite store MUST have a row for this artifact.
        let fetched = store
            .sqlite()
            .get(&art.sha256)
            .expect("sqlite get")
            .expect("row present");
        assert_eq!(fetched.hash, meta.hash);
        assert_eq!(fetched.size_bytes, bytes.len() as u64);
        assert_eq!(store.sqlite().count_artifacts().unwrap(), 1);
    }

    #[test]
    fn metadata_reads_from_sqlite_first() {
        let (dir, store) = open_store();
        let bytes = b"primary-store";
        let (meta, art) = store.ingest(bytes).unwrap();
        // Delete the JSON sidecar — metadata() MUST still succeed via SQLite.
        let hex = art.sha256.strip_prefix("sha256:").unwrap();
        let json_path = dir.path().join("metadata").join(format!("{hex}.json"));
        std::fs::remove_file(&json_path).unwrap();
        let fetched = store.metadata(&art.sha256).unwrap();
        assert_eq!(fetched.hash, meta.hash);
        assert_eq!(fetched.size_bytes, bytes.len() as u64);
    }

    #[test]
    fn metadata_falls_back_to_json_sidecar() {
        let (dir, store) = open_store();
        let bytes = b"fallback";
        let (meta, art) = store.ingest(bytes).unwrap();
        // Simulate SQLite corruption by removing the row. We use a fresh
        // SQLite store so the JSON sidecar is the only source of truth.
        let sqlite_path = dir.path().join("metadata.db");
        // Close the current connection by dropping the store, then remove
        // the SQLite file. Re-open — the JSON sidecar is still there.
        drop(store);
        std::fs::remove_file(&sqlite_path).unwrap();
        // Also remove -wal and -shm if present.
        let _ = std::fs::remove_file(dir.path().join("metadata.db-wal"));
        let _ = std::fs::remove_file(dir.path().join("metadata.db-shm"));
        let store2 = ArtifactStore::open(dir.path()).unwrap();
        let fetched = store2.metadata(&art.sha256).unwrap();
        assert_eq!(fetched.hash, meta.hash);
        assert_eq!(fetched.size_bytes, bytes.len() as u64);
    }

    #[test]
    fn link_creates_row_in_sqlite() {
        let (_dir, store) = open_store();
        let (_, art) = store.ingest(b"linked").unwrap();
        store
            .link(&art.sha256, "task", "task-42", "output")
            .unwrap();
        let links = store.list_by_owner("task", "task-42").unwrap();
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].artifact_hash, art.sha256);
        assert_eq!(links[0].purpose, "output");
    }

    #[test]
    fn gc_dry_run_sqlite_finds_unlinked_artifacts() {
        let (_dir, store) = open_store();
        let (_, a) = store.ingest(b"linked").unwrap();
        let (_, b) = store.ingest(b"unlinked").unwrap();
        store.link(&a.sha256, "task", "task-1", "input").unwrap();
        let collectable = store.gc_dry_run_sqlite().unwrap();
        assert!(collectable.contains(&b.sha256));
        assert!(!collectable.contains(&a.sha256));
    }

    #[test]
    fn gc_dry_run_sqlite_skips_legal_hold() {
        let (_dir, store) = open_store();
        let (mut meta, art) = store.ingest(b"locked").unwrap();
        meta.retention_class = crate::metadata::RetentionClass::LegalHold;
        store.update_metadata(&meta).unwrap();
        let collectable = store.gc_dry_run_sqlite().unwrap();
        assert!(!collectable.contains(&art.sha256));
    }

    #[test]
    fn update_metadata_writes_both_stores() {
        let (dir, store) = open_store();
        let (mut meta, art) = store.ingest(b"original").unwrap();
        meta.retention_class = crate::metadata::RetentionClass::Audit;
        store.update_metadata(&meta).unwrap();
        // SQLite should reflect the new retention class.
        let fetched = store.sqlite().get(&art.sha256).unwrap().unwrap();
        assert_eq!(fetched.retention_class, crate::metadata::RetentionClass::Audit);
        // JSON sidecar should also reflect the new retention class.
        let hex = art.sha256.strip_prefix("sha256:").unwrap();
        let json_path = dir.path().join("metadata").join(format!("{hex}.json"));
        let s = std::fs::read_to_string(&json_path).unwrap();
        let json_meta = crate::metadata::ArtifactMetadata::from_json(&s).unwrap();
        assert_eq!(json_meta.retention_class, crate::metadata::RetentionClass::Audit);
    }
}

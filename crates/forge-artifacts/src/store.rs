use crate::error::ArtifactError;
use crate::metadata::ArtifactMetadata;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// Content-addressed artifact store.
///
/// The store roots at `$FORGE_DATA/artifacts/` (or any directory passed to
/// `open`). Files are laid out as `sha256/ab/cd/<hash>` and metadata as
/// `metadata/<hash>.json`. Temp files live under `tmp/` and are renamed
/// atomically into place.
#[derive(Debug, Clone)]
pub struct ArtifactStore {
    root: PathBuf,
    max_bytes: u64,
}

impl ArtifactStore {
    /// Open or create a store rooted at `root`.
    pub fn open(root: impl Into<PathBuf>) -> Result<Self, ArtifactError> {
        let root = root.into();
        for sub in ["sha256", "metadata", "tmp", "quarantine"] {
            fs::create_dir_all(root.join(sub))?;
        }
        Ok(Self {
            root,
            max_bytes: 4 * 1024 * 1024 * 1024, // 4 GiB default ceiling
        })
    }

    pub fn with_max_bytes(mut self, max: u64) -> Self {
        self.max_bytes = max;
        self
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Ingest bytes into the store. Returns the artifact reference and
    /// metadata. If the artifact already exists, returns the existing
    /// metadata (re-ingest is idempotent).
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
        // Persist metadata if missing.
        if !metadata_path.exists() {
            fs::write(&metadata_path, metadata.to_json()?)?;
        } else if let Ok(s) = fs::read_to_string(&metadata_path) {
            if let Ok(existing) = ArtifactMetadata::from_json(&s) {
                metadata = existing;
            }
        }

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

    /// Fetch metadata for an artifact.
    pub fn metadata(&self, hash: &str) -> Result<ArtifactMetadata, ArtifactError> {
        let hex_hash = strip_sha256_prefix(hash)?;
        validate_hex_hash(hex_hash)?;
        let path = self.metadata_path(hex_hash);
        if !path.exists() {
            // If the blob exists but metadata is missing, derive minimal metadata.
            let blob = self.cas_path(hex_hash);
            if blob.exists() {
                let size = fs::metadata(&blob)?.len();
                return Ok(ArtifactMetadata::new(hash.to_string(), size, "application/octet-stream"));
            }
            return Err(ArtifactError::NotFound(hash.to_string()));
        }
        let s = fs::read_to_string(&path)?;
        ArtifactMetadata::from_json(&s)
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
}

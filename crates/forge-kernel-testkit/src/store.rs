use forge_artifacts::{ArtifactError, ArtifactMetadata, ArtifactStore};
use std::collections::HashMap;
use std::sync::Mutex;

/// An in-memory artifact store. Useful for tests that do not want to touch
/// the filesystem. Implements a subset of the `ArtifactStore` API by
/// delegation: callers construct an `InMemoryArtifactStore` and use it as a
/// regular `ArtifactStore` would be used.
#[derive(Debug, Default)]
pub struct InMemoryArtifactStore {
    blobs: Mutex<HashMap<String, Vec<u8>>>,
    metadata: Mutex<HashMap<String, ArtifactMetadata>>,
}

impl InMemoryArtifactStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn ingest(&self, bytes: &[u8]) -> Result<(ArtifactMetadata, forge_kernel_protocol::ArtifactRef), ArtifactError> {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        let hash = format!("sha256:{}", hex::encode(hasher.finalize()));
        {
            let mut g = match self.blobs.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            g.insert(hash.clone(), bytes.to_vec());
        }
        let metadata = ArtifactMetadata::new(hash.clone(), bytes.len() as u64, "application/octet-stream");
        {
            let mut g = match self.metadata.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            g.insert(hash.clone(), metadata.clone());
        }
        let artifact = forge_kernel_protocol::ArtifactRef::new(
            hash,
            bytes.len() as u64,
            metadata.media_type.clone(),
        );
        Ok((metadata, artifact))
    }

    pub fn get(&self, hash: &str) -> Result<Vec<u8>, ArtifactError> {
        let g = match self.blobs.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        g.get(hash)
            .cloned()
            .ok_or_else(|| ArtifactError::NotFound(hash.to_string()))
    }

    pub fn exists(&self, hash: &str) -> bool {
        let g = match self.blobs.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        g.contains_key(hash)
    }

    pub fn len(&self) -> usize {
        let g = match self.blobs.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        g.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Note: production tests should prefer `ArtifactStore::open(tempdir())`
/// which exercises the real CAS layout. `InMemoryArtifactStore` is provided
/// for very fast unit tests where the on-disk layout is irrelevant.
pub fn real_store_in_tempdir() -> (tempfile::TempDir, ArtifactStore) {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = ArtifactStore::open(dir.path()).expect("open store");
    (dir, store)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_memory_round_trip() {
        let store = InMemoryArtifactStore::new();
        let (_, art) = store.ingest(b"hello").unwrap();
        assert!(store.exists(&art.sha256));
        let got = store.get(&art.sha256).unwrap();
        assert_eq!(got, b"hello");
    }

    #[test]
    fn real_store_in_tempdir_works() {
        let (_dir, store) = real_store_in_tempdir();
        let (_, art) = store.ingest(b"real").unwrap();
        assert!(store.exists(&art.sha256));
    }
}

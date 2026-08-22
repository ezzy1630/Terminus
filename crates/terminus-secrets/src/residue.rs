//! Residue scanning (ADR-0035 §9, SPEC §17.4, roadmap Phase 4 exit gate).
//!
//! Redaction is applied when output streams are persisted; the residue
//! scanner is the independent gate that VERIFIES no registered credential
//! material survived anywhere it should not be — tool envelopes, logs,
//! artifacts, ledger state. A non-empty scan result is a hard failure of
//! the raw-secret canary suite.

use serde::{Deserialize, Serialize};
use sha2::{Digest as ShaDigest, Sha256};

/// One detection: which registered material matched and where.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResidueHit {
    /// Identifier of the registered material.
    pub id: String,
    /// Byte offset of the first match in the scanned buffer.
    pub offset: usize,
}

#[derive(Debug, Clone, Default)]
pub struct ResidueScanner {
    entries: Vec<(String, Vec<u8>)>,
}

impl ResidueScanner {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register literal credential bytes under an identifier. Empty
    /// material is rejected: scanning for "" matches everything.
    pub fn register_literal(
        &mut self,
        id: impl Into<String>,
        material: &[u8],
    ) -> Result<(), crate::error::SecretError> {
        if material.is_empty() {
            return Err(crate::error::SecretError::InvalidGrant(
                "cannot scan for empty material".into(),
            ));
        }
        self.entries.push((id.into(), material.to_vec()));
        Ok(())
    }

    pub fn entry_count(&self) -> usize {
        self.entries.len()
    }

    /// Scan a buffer. Returns every hit; an EMPTY vector is the pass
    /// condition for the canary gate.
    pub fn scan(&self, input: &[u8]) -> Vec<ResidueHit> {
        let mut hits = Vec::new();
        for (id, needle) in &self.entries {
            if let Some(pos) = find(input, needle) {
                hits.push(ResidueHit {
                    id: id.clone(),
                    offset: pos,
                });
            }
        }
        hits
    }

    /// Convenience: true iff any registered material appears in `input`.
    pub fn is_clean(&self, input: &[u8]) -> bool {
        self.scan(input).is_empty()
    }

    /// Scan several named surfaces at once (tool envelope, log capture,
    /// artifact bytes, ledger state JSON...). Returns hits annotated with
    /// the surface name via [`ResidueSurface`].
    pub fn scan_surfaces<'a, I>(&self, surfaces: I) -> Vec<ResidueSurface>
    where
        I: IntoIterator<Item = (&'a str, &'a [u8])>,
    {
        surfaces
            .into_iter()
            .filter_map(|(name, bytes)| {
                let hits = self.scan(bytes);
                if hits.is_empty() {
                    None
                } else {
                    Some(ResidueSurface {
                        surface: name.to_string(),
                        hits,
                    })
                }
            })
            .collect()
    }
}

/// Hits grouped by the output surface they were found in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResidueSurface {
    pub surface: String,
    pub hits: Vec<ResidueHit>,
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.len() > haystack.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Register-and-scan helper for canary suites: derives the scanner from the
/// canary material itself so the test never needs to restate the value.
#[derive(Debug, Clone)]
pub struct CanaryMaterial {
    id: String,
    bytes: Vec<u8>,
}

impl CanaryMaterial {
    pub fn generate(id: impl Into<String>, entropy: &[u8]) -> Self {
        // Deterministic per-entropy derivation keeps tests reproducible
        // while producing high-entropy material unlikely to occur naturally.
        let mut hasher = Sha256::new();
        hasher.update(b"terminus-canary:");
        hasher.update(entropy);
        Self {
            id: id.into(),
            bytes: hasher.finalize().to_vec(),
        }
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn as_str(&self) -> String {
        hex::encode(&self.bytes)
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn scanner(&self) -> ResidueScanner {
        let mut s = ResidueScanner::new();
        // Registration failure is impossible for generated material; map it
        // to a panic-free invariant by filtering empties at generation time.
        let _ = s.register_literal(self.id.clone(), &self.bytes);
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_literal_in_buffer() {
        let mut s = ResidueScanner::new();
        s.register_literal("tok", b"sk-live-abc123").unwrap();
        let hits = s.scan(b"prefix sk-live-abc123 suffix");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "tok");
        assert!(hits[0].offset == 7);
    }

    #[test]
    fn clean_buffer_reports_no_hits() {
        let mut s = ResidueScanner::new();
        s.register_literal("tok", b"sk-live-abc123").unwrap();
        assert!(s.is_clean(b"nothing here"));
        assert!(s.is_clean(b""));
    }

    #[test]
    fn empty_material_rejected() {
        let mut s = ResidueScanner::new();
        assert!(s.register_literal("empty", b"").is_err());
    }

    #[test]
    fn multi_surface_scan_groups_hits() {
        let mut s = ResidueScanner::new();
        s.register_literal("canary", b"CANARYBYTES").unwrap();
        let surfaces = vec![
            ("log", "clean".as_bytes()),
            ("artifact", &b"x CANARYBYTES y"[..]),
        ];
        let found = s.scan_surfaces(surfaces);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].surface, "artifact");
        assert_eq!(found[0].hits.len(), 1);
    }

    #[test]
    fn canary_material_is_deterministic_and_high_entropy() {
        let a = CanaryMaterial::generate("c", b"seed-1");
        let b = CanaryMaterial::generate("c", b"seed-1");
        let c = CanaryMaterial::generate("c", b"seed-2");
        assert_eq!(a.as_bytes(), b.as_bytes());
        assert_ne!(a.as_bytes(), c.as_bytes());
        assert!(!a.as_str().contains("seed"));
        assert!(a.scanner().entry_count() == 1);
    }
}

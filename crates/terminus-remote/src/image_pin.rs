//! Digest-pinned OCI / micro-VM images (SPEC §36.8).

use crate::error::RemoteError;
use serde::{Deserialize, Serialize};

/// An image that MUST be addressed by digest, never by mutable tag alone.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PinnedImage {
    pub repository: String,
    /// Canonical `sha256:<64-hex>`.
    pub digest: String,
}

impl PinnedImage {
    pub fn parse(reference: &str) -> Result<Self, RemoteError> {
        // Accept `repo@sha256:hex` only. Reject `repo:tag`.
        let Some((repository, digest)) = reference.rsplit_once('@') else {
            return Err(RemoteError::MutableImageTag);
        };
        if repository.is_empty() {
            return Err(RemoteError::InvalidEnvironment(
                "empty image repository".into(),
            ));
        }
        if repository.contains(':') && !repository.contains('/') {
            // Ambiguous host:port without path — still allow if digest present.
        }
        let image = Self {
            repository: repository.to_string(),
            digest: digest.to_string(),
        };
        image.validate()?;
        Ok(image)
    }

    pub fn validate(&self) -> Result<(), RemoteError> {
        if self.repository.is_empty() || self.repository.contains('@') {
            return Err(RemoteError::InvalidEnvironment(
                "invalid image repository".into(),
            ));
        }
        if !self.digest.starts_with("sha256:") || self.digest.len() != "sha256:".len() + 64 {
            return Err(RemoteError::MutableImageTag);
        }
        if !self.digest[7..].chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(RemoteError::MutableImageTag);
        }
        Ok(())
    }

    pub fn reference(&self) -> String {
        format!("{}@{}", self.repository, self.digest)
    }

    pub fn assert_matches(&self, observed_digest: &str) -> Result<(), RemoteError> {
        if observed_digest != self.digest {
            return Err(RemoteError::DigestMismatch {
                expected: self.digest.clone(),
                actual: observed_digest.to_string(),
            });
        }
        Ok(())
    }
}

/// Rejects tag-only references used by the old container stub.
pub fn reject_mutable_tag(reference: &str) -> Result<(), RemoteError> {
    if reference.contains('@') {
        PinnedImage::parse(reference).map(|_| ())
    } else {
        Err(RemoteError::MutableImageTag)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_digest_ref() {
        let img = PinnedImage::parse(
            "alpine@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        )
        .expect("parse");
        assert_eq!(img.repository, "alpine");
    }

    #[test]
    fn rejects_latest() {
        assert!(matches!(
            reject_mutable_tag("alpine:latest"),
            Err(RemoteError::MutableImageTag)
        ));
    }
}

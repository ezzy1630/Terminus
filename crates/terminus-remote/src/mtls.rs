//! mTLS material descriptors. Private key bytes never live in this type's Debug.

use crate::error::RemoteError;
use crate::identity::Identity;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Paths to PEM material for mutual TLS. Contents are not loaded here so the
/// type stays free of secret bytes; loaders live at the transport boundary.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MtlsMaterial {
    pub cert_pem_path: PathBuf,
    pub key_pem_path: PathBuf,
    pub client_ca_pem_path: PathBuf,
    /// Expected peer identity encoded in the cert SAN / URI.
    pub expected_peer: Identity,
    /// Optional pinned cert fingerprint `sha256:<hex>` of the leaf cert DER.
    pub pinned_peer_fingerprint: Option<String>,
}

impl std::fmt::Debug for MtlsMaterial {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MtlsMaterial")
            .field("cert_pem_path", &self.cert_pem_path)
            .field("key_pem_path", &"<redacted-path>")
            .field("client_ca_pem_path", &self.client_ca_pem_path)
            .field("expected_peer", &self.expected_peer)
            .field("pinned_peer_fingerprint", &self.pinned_peer_fingerprint)
            .finish()
    }
}

impl MtlsMaterial {
    pub fn validate(&self) -> Result<(), RemoteError> {
        if self.cert_pem_path.as_os_str().is_empty()
            || self.key_pem_path.as_os_str().is_empty()
            || self.client_ca_pem_path.as_os_str().is_empty()
        {
            return Err(RemoteError::MtlsConfig(
                "cert, key, and client CA paths are required".into(),
            ));
        }
        if let Some(fp) = &self.pinned_peer_fingerprint {
            if !fp.starts_with("sha256:") || fp.len() != "sha256:".len() + 64 {
                return Err(RemoteError::MtlsConfig(
                    "pinned fingerprint must be sha256:<64-hex>".into(),
                ));
            }
        }
        Ok(())
    }

    /// Bind a presented peer identity + optional fingerprint to this material.
    pub fn authorize_peer(
        &self,
        presented: &Identity,
        presented_fingerprint: Option<&str>,
    ) -> Result<(), RemoteError> {
        if presented != &self.expected_peer {
            return Err(RemoteError::IsolationViolation(format!(
                "mtls peer {} != expected {}",
                presented.as_str(),
                self.expected_peer.as_str()
            )));
        }
        if let Some(expected_fp) = &self.pinned_peer_fingerprint {
            match presented_fingerprint {
                Some(actual) if actual == expected_fp => Ok(()),
                Some(actual) => Err(RemoteError::IsolationViolation(format!(
                    "cert fingerprint mismatch: expected {expected_fp}, got {actual}"
                ))),
                None => Err(RemoteError::IsolationViolation(
                    "pinned fingerprint required but none presented".into(),
                )),
            }
        } else {
            Ok(())
        }
    }
}

/// How the control plane reaches a kernel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum KernelTransport {
    Uds {
        socket_path: PathBuf,
    },
    Mtls {
        /// `host:port` — never a URL with credentials.
        endpoint: String,
        material: MtlsMaterial,
    },
}

impl KernelTransport {
    pub fn validate(&self) -> Result<(), RemoteError> {
        match self {
            Self::Uds { socket_path } => {
                if socket_path.as_os_str().is_empty() {
                    return Err(RemoteError::MtlsConfig("UDS socket path required".into()));
                }
                Ok(())
            }
            Self::Mtls { endpoint, material } => {
                if endpoint.is_empty() || endpoint.contains("://") || endpoint.contains('@') {
                    return Err(RemoteError::MtlsConfig(
                        "mTLS endpoint must be host:port without scheme or credentials".into(),
                    ));
                }
                material.validate()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::{Identity, IdentityKind};

    #[test]
    fn rejects_url_shaped_endpoint() {
        let material = MtlsMaterial {
            cert_pem_path: PathBuf::from("c.pem"),
            key_pem_path: PathBuf::from("k.pem"),
            client_ca_pem_path: PathBuf::from("ca.pem"),
            expected_peer: Identity::new(IdentityKind::Kernel, "k1").expect("id"),
            pinned_peer_fingerprint: None,
        };
        let t = KernelTransport::Mtls {
            endpoint: "https://evil".into(),
            material,
        };
        assert!(t.validate().is_err());
    }

    #[test]
    fn authorize_peer_checks_fingerprint() {
        let peer = Identity::new(IdentityKind::Control, "c1").expect("id");
        let material = MtlsMaterial {
            cert_pem_path: PathBuf::from("c.pem"),
            key_pem_path: PathBuf::from("k.pem"),
            client_ca_pem_path: PathBuf::from("ca.pem"),
            expected_peer: peer.clone(),
            pinned_peer_fingerprint: Some(
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
            ),
        };
        assert!(material
            .authorize_peer(
                &peer,
                Some("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
            )
            .is_ok());
        assert!(material.authorize_peer(&peer, None).is_err());
    }
}

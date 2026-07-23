//! Kernel, server, workspace, and control-plane identities.
//!
//! Identities are opaque strings with validated prefixes. Cert SANs and
//! capability-token `kernel_instance_id` MUST agree on the kernel identity.

use crate::error::RemoteError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Opaque identity with a stable string form.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Identity {
    kind: IdentityKind,
    value: String,
}

/// Which component an identity names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IdentityKind {
    Kernel,
    Server,
    Workspace,
    Control,
}

impl IdentityKind {
    fn prefix(self) -> &'static str {
        match self {
            Self::Kernel => "kernel:",
            Self::Server => "server:",
            Self::Workspace => "workspace:",
            Self::Control => "control:",
        }
    }
}

impl Identity {
    /// Parse `kind:opaque` form. Opaque part must be non-empty and must not
    /// contain whitespace or the `:` separator.
    pub fn parse(raw: &str) -> Result<Self, RemoteError> {
        let (kind, value) = if let Some(rest) = raw.strip_prefix("kernel:") {
            (IdentityKind::Kernel, rest)
        } else if let Some(rest) = raw.strip_prefix("server:") {
            (IdentityKind::Server, rest)
        } else if let Some(rest) = raw.strip_prefix("workspace:") {
            (IdentityKind::Workspace, rest)
        } else if let Some(rest) = raw.strip_prefix("control:") {
            (IdentityKind::Control, rest)
        } else {
            return Err(RemoteError::InvalidIdentity(format!(
                "missing kind prefix: {raw}"
            )));
        };
        if value.is_empty() || value.contains(':') || value.chars().any(char::is_whitespace) {
            return Err(RemoteError::InvalidIdentity(format!(
                "invalid opaque identity body: {raw}"
            )));
        }
        Ok(Self {
            kind,
            value: value.to_string(),
        })
    }

    pub fn new(kind: IdentityKind, value: impl Into<String>) -> Result<Self, RemoteError> {
        let value = value.into();
        if value.is_empty() || value.contains(':') || value.chars().any(char::is_whitespace) {
            return Err(RemoteError::InvalidIdentity(
                "opaque identity body must be non-empty without ':' or whitespace".into(),
            ));
        }
        Ok(Self { kind, value })
    }

    pub fn kind(&self) -> IdentityKind {
        self.kind
    }

    pub fn value(&self) -> &str {
        &self.value
    }

    pub fn as_str(&self) -> String {
        format!("{}{}", self.kind.prefix(), self.value)
    }

    /// SHA-256 fingerprint of the identity string (for cert SAN binding checks).
    pub fn fingerprint_sha256(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(self.as_str().as_bytes());
        format!("sha256:{}", hex::encode(hasher.finalize()))
    }
}

/// Bundle of identities that define a single-tenant remote deployment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeploymentIdentities {
    pub server: Identity,
    pub kernel: Identity,
    pub control: Identity,
}

impl DeploymentIdentities {
    pub fn validate(&self) -> Result<(), RemoteError> {
        if self.server.kind() != IdentityKind::Server {
            return Err(RemoteError::InvalidIdentity(
                "server identity has wrong kind".into(),
            ));
        }
        if self.kernel.kind() != IdentityKind::Kernel {
            return Err(RemoteError::InvalidIdentity(
                "kernel identity has wrong kind".into(),
            ));
        }
        if self.control.kind() != IdentityKind::Control {
            return Err(RemoteError::InvalidIdentity(
                "control identity has wrong kind".into(),
            ));
        }
        Ok(())
    }

    /// Capability tokens must bind to this kernel instance id string.
    pub fn kernel_instance_id(&self) -> String {
        self.kernel.as_str()
    }

    /// Reject a peer claiming a different kernel identity (isolation).
    pub fn assert_kernel_peer(&self, peer: &Identity) -> Result<(), RemoteError> {
        if peer != &self.kernel {
            return Err(RemoteError::IsolationViolation(format!(
                "peer {} does not match deployment kernel {}",
                peer.as_str(),
                self.kernel.as_str()
            )));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_round_trip() {
        let id = Identity::parse("kernel:abc-123").expect("parse");
        assert_eq!(id.kind(), IdentityKind::Kernel);
        assert_eq!(id.as_str(), "kernel:abc-123");
    }

    #[test]
    fn rejects_whitespace() {
        assert!(Identity::parse("kernel:bad id").is_err());
    }

    #[test]
    fn isolation_rejects_wrong_kernel() {
        let dep = DeploymentIdentities {
            server: Identity::new(IdentityKind::Server, "s1").expect("s"),
            kernel: Identity::new(IdentityKind::Kernel, "k1").expect("k"),
            control: Identity::new(IdentityKind::Control, "c1").expect("c"),
        };
        let other = Identity::new(IdentityKind::Kernel, "k2").expect("k2");
        assert!(matches!(
            dep.assert_kernel_peer(&other),
            Err(RemoteError::IsolationViolation(_))
        ));
    }
}

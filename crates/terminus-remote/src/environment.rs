//! Remote environment descriptors (SPEC §48.14).

use crate::error::RemoteError;
use crate::identity::Identity;
use crate::image_pin::PinnedImage;
use crate::mtls::KernelTransport;
use serde::{Deserialize, Serialize};

/// Execution backend class for a remote environment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvironmentBackend {
    Container,
    MicroVm,
    HostProcess,
}

/// Declarative description of a remote execution environment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteEnvironmentDescriptor {
    pub workspace_identity: Identity,
    pub kernel_identity: Identity,
    pub transport: KernelTransport,
    pub backend: EnvironmentBackend,
    pub image: PinnedImage,
    pub policy_profile: String,
    pub trust: String,
    /// Optional resource class name used by the pool.
    pub resource_class: String,
}

impl RemoteEnvironmentDescriptor {
    pub fn validate(&self) -> Result<(), RemoteError> {
        if self.workspace_identity.kind() != crate::identity::IdentityKind::Workspace {
            return Err(RemoteError::InvalidEnvironment(
                "workspace_identity must be workspace:*".into(),
            ));
        }
        if self.kernel_identity.kind() != crate::identity::IdentityKind::Kernel {
            return Err(RemoteError::InvalidEnvironment(
                "kernel_identity must be kernel:*".into(),
            ));
        }
        self.transport.validate()?;
        self.image.validate()?;
        if self.policy_profile.is_empty() {
            return Err(RemoteError::InvalidEnvironment(
                "policy_profile required".into(),
            ));
        }
        match self.trust.as_str() {
            "trusted" | "untrusted" | "restricted" => {}
            other => {
                return Err(RemoteError::InvalidEnvironment(format!(
                    "invalid trust label: {other}"
                )));
            }
        }
        if matches!(self.backend, EnvironmentBackend::HostProcess)
            && matches!(self.trust.as_str(), "untrusted" | "restricted")
        {
            return Err(RemoteError::InvalidEnvironment(
                "untrusted/restricted remote envs require container or microvm".into(),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::{Identity, IdentityKind};
    use crate::image_pin::PinnedImage;
    use crate::mtls::KernelTransport;
    use std::path::PathBuf;

    fn sample() -> RemoteEnvironmentDescriptor {
        RemoteEnvironmentDescriptor {
            workspace_identity: Identity::new(IdentityKind::Workspace, "ws1").expect("w"),
            kernel_identity: Identity::new(IdentityKind::Kernel, "k1").expect("k"),
            transport: KernelTransport::Uds {
                socket_path: PathBuf::from("/tmp/k.sock"),
            },
            backend: EnvironmentBackend::Container,
            image: PinnedImage {
                repository: "ghcr.io/terminus/python".into(),
                digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                    .into(),
            },
            policy_profile: "container-untrusted".into(),
            trust: "untrusted".into(),
            resource_class: "default".into(),
        }
    }

    #[test]
    fn validates_ok() {
        sample().validate().expect("ok");
    }

    #[test]
    fn rejects_host_for_untrusted() {
        let mut d = sample();
        d.backend = EnvironmentBackend::HostProcess;
        assert!(d.validate().is_err());
    }
}

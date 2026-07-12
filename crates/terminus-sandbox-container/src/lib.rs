//! Container sandbox backend. Requires runtime configuration (OCI runtime,
//! image digest, resource limits) that is not yet wired up; fails closed.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]
#![forbid(unsafe_code)]

use terminus_sandbox::profile::SandboxProfile;
use terminus_sandbox::report::{EnforcementFeature, EnforcementReport, EnforcementStatus};
use terminus_sandbox::{SandboxBackend, SandboxError};

#[derive(Debug, Clone, Default)]
pub struct ContainerSandboxBackend {
    runtime_configured: bool,
}

impl ContainerSandboxBackend {
    pub fn new() -> Self {
        Self {
            runtime_configured: false,
        }
    }

    pub fn with_runtime_configured(runtime_configured: bool) -> Self {
        Self { runtime_configured }
    }
}

impl SandboxBackend for ContainerSandboxBackend {
    fn id(&self) -> &'static str {
        "container"
    }

    fn enforcement_report(&self) -> EnforcementReport {
        if self.runtime_configured {
            return EnforcementReport {
                backend_id: self.id().to_string(),
                status: EnforcementStatus::Enforced,
                enforced: vec![
                    EnforcementFeature::FilesystemIsolation,
                    EnforcementFeature::NetworkIsolation,
                    EnforcementFeature::ProcessIsolation,
                    EnforcementFeature::CgroupResourceLimits,
                    EnforcementFeature::MountNamespace,
                    EnforcementFeature::PidNamespace,
                ],
                degraded: vec![],
                unsupported: vec![
                    EnforcementFeature::SeccompFilter,
                    EnforcementFeature::NoNewPrivs,
                    EnforcementFeature::UserNamespace,
                ],
                notes: vec!["OCI runtime configured".to_string()],
            };
        }
        EnforcementReport {
            backend_id: self.id().to_string(),
            status: EnforcementStatus::Unsupported,
            enforced: vec![],
            degraded: vec![],
            unsupported: vec![
                EnforcementFeature::FilesystemIsolation,
                EnforcementFeature::NetworkIsolation,
                EnforcementFeature::ProcessIsolation,
                EnforcementFeature::CgroupResourceLimits,
            ],
            notes: vec!["container backend requires runtime configuration".to_string()],
        }
    }

    fn supports_profile(&self, _profile: &SandboxProfile) -> Result<(), SandboxError> {
        if self.runtime_configured {
            Ok(())
        } else {
            Err(SandboxError::Unsupported(
                "container backend requires runtime configuration".into(),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn container_fails_closed_when_unconfigured() {
        let backend = ContainerSandboxBackend::new();
        let err = backend
            .supports_profile(&SandboxProfile::default_restrictive())
            .unwrap_err();
        assert!(matches!(err, SandboxError::Unsupported(_)));
    }

    #[test]
    fn container_supports_when_configured() {
        let backend = ContainerSandboxBackend::with_runtime_configured(true);
        backend
            .supports_profile(&SandboxProfile::default_restrictive())
            .unwrap();
    }
}

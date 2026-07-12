//! macOS sandbox backend. Seatbelt profile application is not implemented in
//! this build; the backend fails closed.

#![forbid(unsafe_code)]

use forge_sandbox::profile::SandboxProfile;
use forge_sandbox::report::{EnforcementFeature, EnforcementReport, EnforcementStatus};
use forge_sandbox::{SandboxBackend, SandboxError};

#[derive(Debug, Clone, Default)]
pub struct MacOsSandboxBackend;

impl MacOsSandboxBackend {
    pub fn new() -> Self {
        Self
    }
}

impl SandboxBackend for MacOsSandboxBackend {
    fn id(&self) -> &'static str {
        "macos"
    }

    fn enforcement_report(&self) -> EnforcementReport {
        EnforcementReport {
            backend_id: self.id().to_string(),
            status: EnforcementStatus::Unsupported,
            enforced: vec![],
            degraded: vec![],
            unsupported: vec![
                EnforcementFeature::FilesystemIsolation,
                EnforcementFeature::NetworkIsolation,
                EnforcementFeature::SeccompFilter,
                EnforcementFeature::NoNewPrivs,
                EnforcementFeature::PidNamespace,
                EnforcementFeature::MountNamespace,
                EnforcementFeature::UserNamespace,
                EnforcementFeature::CgroupResourceLimits,
            ],
            notes: vec![
                "seatbelt profile application not implemented in this build".to_string(),
                "fail closed: prefer forge-sandbox-container".to_string(),
            ],
        }
    }

    fn supports_profile(&self, _profile: &SandboxProfile) -> Result<(), SandboxError> {
        Err(SandboxError::Unsupported(
            "macOS seatbelt backend not implemented".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_sandbox::SandboxProfile;

    #[test]
    fn macos_backend_fails_closed() {
        let backend = MacOsSandboxBackend::new();
        let err = backend
            .supports_profile(&SandboxProfile::default_restrictive())
            .unwrap_err();
        assert!(matches!(err, SandboxError::Unsupported(_)));
    }
}

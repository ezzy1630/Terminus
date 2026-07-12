//! Windows sandbox backend. AppContainer/Job Object enforcement is not
//! implemented in this build; the backend fails closed.

#![forbid(unsafe_code)]

use forge_sandbox::profile::SandboxProfile;
use forge_sandbox::report::{EnforcementFeature, EnforcementReport, EnforcementStatus};
use forge_sandbox::{SandboxBackend, SandboxError};

#[derive(Debug, Clone, Default)]
pub struct WindowsSandboxBackend;

impl WindowsSandboxBackend {
    pub fn new() -> Self {
        Self
    }
}

impl SandboxBackend for WindowsSandboxBackend {
    fn id(&self) -> &'static str {
        "windows"
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
                EnforcementFeature::PidNamespace,
                EnforcementFeature::MountNamespace,
                EnforcementFeature::UserNamespace,
                EnforcementFeature::CgroupResourceLimits,
            ],
            notes: vec![
                "AppContainer/Job Object backend not implemented in this build".to_string(),
                "fail closed: prefer forge-sandbox-container or WSL2".to_string(),
            ],
        }
    }

    fn supports_profile(&self, _profile: &SandboxProfile) -> Result<(), SandboxError> {
        Err(SandboxError::Unsupported(
            "Windows AppContainer backend not implemented".into(),
        ))
    }
}

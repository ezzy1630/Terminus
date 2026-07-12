use forge_sandbox::profile::SandboxProfile;
use forge_sandbox::report::{EnforcementFeature, EnforcementReport, EnforcementStatus};
use forge_sandbox::{SandboxBackend, SandboxError};

/// A mock sandbox for tests. Always reports `Enforced` and supports any
/// profile that does not request ambient secrets.
#[derive(Debug, Clone, Default)]
pub struct MockSandbox {
    enforced_features: Vec<EnforcementFeature>,
}

impl MockSandbox {
    pub fn new() -> Self {
        Self {
            enforced_features: vec![
                EnforcementFeature::FilesystemIsolation,
                EnforcementFeature::NetworkIsolation,
                EnforcementFeature::ProcessIsolation,
                EnforcementFeature::SeccompFilter,
                EnforcementFeature::NoNewPrivs,
                EnforcementFeature::CgroupResourceLimits,
                EnforcementFeature::AmbientSecretDenial,
                EnforcementFeature::PluginAmbientAuthorityDenial,
                EnforcementFeature::PidNamespace,
                EnforcementFeature::MountNamespace,
                EnforcementFeature::UserNamespace,
            ],
        }
    }

    pub fn with_features(features: Vec<EnforcementFeature>) -> Self {
        Self {
            enforced_features: features,
        }
    }
}

impl SandboxBackend for MockSandbox {
    fn id(&self) -> &'static str {
        "mock"
    }

    fn enforcement_report(&self) -> EnforcementReport {
        EnforcementReport {
            backend_id: self.id().to_string(),
            status: EnforcementStatus::Enforced,
            enforced: self.enforced_features.clone(),
            degraded: vec![],
            unsupported: vec![],
            notes: vec!["mock sandbox for tests".to_string()],
        }
    }

    fn supports_profile(&self, profile: &SandboxProfile) -> Result<(), SandboxError> {
        if matches!(
            profile.secrets,
            forge_sandbox::SecretsAccess::AmbientEnvironment
        ) {
            return Err(SandboxError::Misconfigured(
                "mock sandbox rejects ambient secrets".into(),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mock_reports_enforced() {
        let backend = MockSandbox::new();
        let report = backend.enforcement_report();
        assert_eq!(report.status, EnforcementStatus::Enforced);
    }
}

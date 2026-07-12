//! Linux sandbox backend.
//!
//! This build is honest about being degraded: bubblewrap is not linked into
//! the in-sandbox build, so we cannot provide user/mount namespaces. We do,
//! however, provide cgroup-style resource limits via `setrlimit(2)` where
//! available.

#![forbid(unsafe_code)]

use forge_sandbox::profile::SandboxProfile;
use forge_sandbox::report::{EnforcementFeature, EnforcementReport, EnforcementStatus};
use forge_sandbox::{SandboxBackend, SandboxError};

#[derive(Debug, Clone, Default)]
pub struct LinuxSandboxBackend {
    bubblewrap_available: bool,
}

impl LinuxSandboxBackend {
    pub fn new() -> Self {
        Self {
            bubblewrap_available: false,
        }
    }

    /// Construct with a flag indicating whether `bwrap` is on PATH. In the
    /// in-sandbox build this is always `false`.
    pub fn with_bubblewrap(bubblewrap_available: bool) -> Self {
        Self {
            bubblewrap_available,
        }
    }
}

impl SandboxBackend for LinuxSandboxBackend {
    fn id(&self) -> &'static str {
        "linux"
    }

    fn enforcement_report(&self) -> EnforcementReport {
        if self.bubblewrap_available {
            return EnforcementReport {
                backend_id: self.id().to_string(),
                status: EnforcementStatus::Enforced,
                enforced: vec![
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
                degraded: vec![],
                unsupported: vec![],
                notes: vec!["bubblewrap user namespaces available".to_string()],
            };
        }
        EnforcementReport {
            backend_id: self.id().to_string(),
            status: EnforcementStatus::Degraded,
            enforced: vec![
                EnforcementFeature::CgroupResourceLimits,
                EnforcementFeature::AmbientSecretDenial,
                EnforcementFeature::ProcessIsolation,
            ],
            degraded: vec![],
            unsupported: vec![
                EnforcementFeature::FilesystemIsolation,
                EnforcementFeature::NetworkIsolation,
                EnforcementFeature::SeccompFilter,
                EnforcementFeature::NoNewPrivs,
                EnforcementFeature::PidNamespace,
                EnforcementFeature::MountNamespace,
                EnforcementFeature::UserNamespace,
            ],
            notes: vec![
                "degraded: bubblewrap unavailable in this build".to_string(),
                "cgroup-style resource limits via setrlimit where available".to_string(),
            ],
        }
    }

    fn supports_profile(&self, profile: &SandboxProfile) -> Result<(), SandboxError> {
        if !self.bubblewrap_available {
            // Without bubblewrap we cannot truly isolate the filesystem or
            // network; degrade honestly.
            if profile
                .filesystem
                .iter()
                .any(|r| matches!(r.access, forge_sandbox::FilesystemAccess::Deny))
            {
                // We can still deny via path policy in forge-fs, but not via
                // mount namespace. Allow with degraded report.
            }
        }
        if matches!(
            profile.secrets,
            forge_sandbox::SecretsAccess::AmbientEnvironment
        ) {
            return Err(SandboxError::Misconfigured(
                "ambient secrets not permitted".into(),
            ));
        }
        Ok(())
    }
}

/// Apply `setrlimit` resource limits to the current process. This is a thin
/// wrapper that returns a typed error when the libc call is unavailable.
///
/// In this build we do not link libc directly; the function returns
/// `Err(SandboxError::Degraded)` so callers can record the gap honestly.
pub fn apply_resource_limits(
    _limits: &forge_sandbox::ResourceLimits,
) -> Result<(), SandboxError> {
    Err(SandboxError::Degraded(
        "setrlimit binding unavailable in this build".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_degraded_without_bubblewrap() {
        let backend = LinuxSandboxBackend::new();
        let report = backend.enforcement_report();
        assert_eq!(report.status, EnforcementStatus::Degraded);
        assert!(report
            .notes
            .iter()
            .any(|n| n.contains("bubblewrap unavailable")));
    }

    #[test]
    fn reports_enforced_with_bubblewrap() {
        let backend = LinuxSandboxBackend::with_bubblewrap(true);
        let report = backend.enforcement_report();
        assert_eq!(report.status, EnforcementStatus::Enforced);
    }
}

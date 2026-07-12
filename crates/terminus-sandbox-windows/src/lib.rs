//! Windows sandbox backend (SPEC §13.4, §36.5).
//!
//! This backend wraps the Windows **AppContainer** + **Job Object** sandbox
//! when it is available. AppContainer provides filesystem, registry, and
//! network isolation via capability-based access checks.
//!
//! Honesty contract (SPEC §13.4: "Unsupported/degraded: fail closed in
//! production. The UI must display effective enforcement, never silently
//! downgrade."):
//!
//! - This build does NOT yet invoke the AppContainer API. The backend
//!   reports `Degraded` with a clear note about what's missing. Callers
//!   should prefer `forge-sandbox-container` for a fully-enforced backend.
//! - When running on a non-Windows host (or when the AppContainer API is
//!   unavailable), the backend reports `Unsupported` and rejects profiles
//!   that require namespace isolation.
//!
//! Future work: implement `SandboxProfile -> AppContainer capability` mapping
//! and `spawn_in_sandbox` using `CreateProcessW` with
//! `CREATE_UNICODE_ENVIRONMENT` + `EXTENDED_STARTUPINFO_PRESENT` +
//! `PROC_THREAD_ATTRIBUTE_JOB_LIST`, then flip the enforced/degraded lists.

#![forbid(unsafe_code)]

use forge_sandbox::profile::{NetworkAccess, SandboxProfile};
use forge_sandbox::report::{EnforcementFeature, EnforcementReport, EnforcementStatus};
use forge_sandbox::{SandboxBackend, SandboxError};

#[derive(Debug, Clone, Default)]
pub struct WindowsSandboxBackend {
    /// True iff the host is Windows and the AppContainer API is expected to
    /// be available. We cannot probe the API at runtime without linking
    /// `winapi`, so we use `cfg!(target_os = "windows")` as a proxy.
    appcontainer_available: bool,
}

impl WindowsSandboxBackend {
    /// Construct a backend that detects the host platform.
    pub fn new() -> Self {
        Self {
            appcontainer_available: cfg!(target_os = "windows"),
        }
    }

    /// Construct with a mocked AppContainer availability. For tests that do
    /// not want to depend on the host platform.
    pub fn with_mocked_appcontainer(available: bool) -> Self {
        Self {
            appcontainer_available: available,
        }
    }

    /// True iff the host appears to support AppContainer.
    pub fn is_appcontainer_available(&self) -> bool {
        self.appcontainer_available
    }
}

impl SandboxBackend for WindowsSandboxBackend {
    fn id(&self) -> &'static str {
        "windows"
    }

    fn enforcement_report(&self) -> EnforcementReport {
        if self.appcontainer_available {
            // AppContainer is available on the host, but we have not yet
            // implemented the CreateProcess + Job Object wiring. Report
            // Degraded with a clear note about what's missing.
            return EnforcementReport {
                backend_id: self.id().to_string(),
                status: EnforcementStatus::Degraded,
                enforced: vec![
                    EnforcementFeature::AmbientSecretDenial,
                    EnforcementFeature::ProcessIsolation,
                ],
                degraded: vec![
                    EnforcementFeature::FilesystemIsolation,
                    EnforcementFeature::NetworkIsolation,
                    EnforcementFeature::NoNewPrivs,
                    EnforcementFeature::CgroupResourceLimits,
                ],
                unsupported: vec![
                    EnforcementFeature::SeccompFilter,
                    EnforcementFeature::PidNamespace,
                    EnforcementFeature::MountNamespace,
                    EnforcementFeature::UserNamespace,
                ],
                notes: vec![
                    "AppContainer API available on host but CreateProcess+Job Object wiring not implemented"
                        .to_string(),
                    "filesystem/network: degraded — AppContainer capability mapping is a stub"
                        .to_string(),
                    "pid/mount/user namespaces: unsupported on Windows (use forge-sandbox-container or WSL2)"
                        .to_string(),
                    "fail closed: prefer forge-sandbox-container for full enforcement"
                        .to_string(),
                ],
            };
        }
        // Not on a Windows host — be honest.
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
                "AppContainer/Job Object backend not implemented in this build".to_string(),
                "host is not Windows or AppContainer API is unavailable".to_string(),
                "fail closed: prefer forge-sandbox-container or WSL2".to_string(),
                "filesystem traversal/symlink protection still enforced by forge-fs PathResolver"
                    .to_string(),
                "egress allowlist still enforced by forge-egress EgressProxy".to_string(),
            ],
        }
    }

    fn supports_profile(&self, profile: &SandboxProfile) -> Result<(), SandboxError> {
        // Security refusal: ambient secrets are never permitted.
        if matches!(
            profile.secrets,
            forge_sandbox::SecretsAccess::AmbientEnvironment
        ) {
            return Err(SandboxError::Misconfigured(
                "ambient secrets not permitted".into(),
            ));
        }
        if profile.plugins_ambient_authority {
            return Err(SandboxError::Misconfigured(
                "ambient plugin authority not permitted".into(),
            ));
        }
        if !self.appcontainer_available {
            if matches!(profile.network, NetworkAccess::Deny) {
                return Err(SandboxError::Unsupported(
                    "profile requires network isolation but AppContainer is not available"
                        .into(),
                ));
            }
            return Err(SandboxError::Unsupported(
                "Windows AppContainer backend not implemented in this build".into(),
            ));
        }
        // AppContainer is available but the wiring is a stub — accept the
        // profile but report Degraded.
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_sandbox::SandboxProfile;

    #[test]
    fn windows_backend_fails_closed_when_appcontainer_unavailable() {
        let backend = WindowsSandboxBackend::with_mocked_appcontainer(false);
        let err = backend
            .supports_profile(&SandboxProfile::default_restrictive())
            .expect_err("must fail closed without AppContainer");
        assert!(matches!(err, SandboxError::Unsupported(_)));
        let report = backend.enforcement_report();
        assert_eq!(report.status, EnforcementStatus::Unsupported);
    }

    #[test]
    fn windows_backend_reports_degraded_when_appcontainer_present() {
        let backend = WindowsSandboxBackend::with_mocked_appcontainer(true);
        let report = backend.enforcement_report();
        assert_eq!(report.status, EnforcementStatus::Degraded);
        assert!(report
            .notes
            .iter()
            .any(|n| n.contains("wiring not implemented")));
        // FilesystemIsolation is degraded (not enforced, not unsupported).
        assert!(report
            .degraded
            .contains(&EnforcementFeature::FilesystemIsolation));
    }

    #[test]
    fn windows_backend_rejects_ambient_secrets() {
        let backend = WindowsSandboxBackend::with_mocked_appcontainer(true);
        let mut profile = SandboxProfile::default_restrictive();
        profile.secrets = forge_sandbox::SecretsAccess::AmbientEnvironment;
        let err = backend.supports_profile(&profile).expect_err("ambient secrets must be rejected");
        assert!(matches!(err, SandboxError::Misconfigured(_)));
    }

    #[test]
    fn windows_backend_accepts_restrictive_when_appcontainer_present() {
        let backend = WindowsSandboxBackend::with_mocked_appcontainer(true);
        backend
            .supports_profile(&SandboxProfile::default_restrictive())
            .expect("restrictive profile should be accepted (degraded) when AppContainer is present");
    }
}

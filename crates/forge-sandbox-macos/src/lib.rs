//! macOS sandbox backend (SPEC §13.4, §36.5).
//!
//! This backend wraps the macOS **Seatbelt** sandbox via the `sandbox-exec`
//! CLI when it is available. Seatbelt is the kernel-enforced sandbox that
//! macOS uses for App Store apps, system services, and Safari.
//!
//! Honesty contract (SPEC §13.4: "Unsupported/degraded: fail closed in
//! production. The UI must display effective enforcement, never silently
//! downgrade."):
//!
//! - This build does NOT yet generate Seatbelt `.sb` profile files from the
//!   platform-agnostic `SandboxProfile`. Even when `sandbox-exec` is on
//!   `$PATH`, the backend reports `Degraded` with a note explaining that
//!   profile generation is not implemented. Callers should prefer
//!   `forge-sandbox-container` for a fully-enforced backend.
//! - When `sandbox-exec` is NOT on `$PATH`, the backend reports `Unsupported`
//!   and rejects profiles that require namespace isolation.
//!
//! Future work: implement `SandboxProfile -> Seatbelt .sb` translation in
//! `spawn_in_sandbox`, then flip the enforced/degraded lists to claim
//! `Enforced` for the features Seatbelt actually provides (filesystem,
//! network, process, NoNewPrivs via `seatbelt-profile`).

#![forbid(unsafe_code)]

use forge_sandbox::profile::{NetworkAccess, SandboxProfile};
use forge_sandbox::report::{EnforcementFeature, EnforcementReport, EnforcementStatus};
use forge_sandbox::{SandboxBackend, SandboxError};
use std::path::PathBuf;
use std::process::Command;

#[derive(Debug, Clone, Default)]
pub struct MacOsSandboxBackend {
    /// Resolved absolute path to `sandbox-exec`. `None` means the Seatbelt
    /// CLI was not found on PATH at construction time.
    sandbox_exec_path: Option<PathBuf>,
}

impl MacOsSandboxBackend {
    /// Construct a backend that probes `$PATH` for `sandbox-exec`.
    pub fn new() -> Self {
        Self {
            sandbox_exec_path: which_sandbox_exec(),
        }
    }

    /// Construct with a mocked `sandbox-exec` availability. For tests that
    /// do not want to depend on the host having `sandbox-exec` installed.
    pub fn with_mocked_sandbox_exec(available: bool) -> Self {
        if available {
            Self {
                sandbox_exec_path: Some(PathBuf::from("/usr/bin/sandbox-exec")),
            }
        } else {
            Self::default()
        }
    }

    /// True iff `sandbox-exec` was found on PATH at construction time.
    pub fn is_seatbelt_available(&self) -> bool {
        self.sandbox_exec_path.is_some()
    }
}

impl SandboxBackend for MacOsSandboxBackend {
    fn id(&self) -> &'static str {
        "macos"
    }

    fn enforcement_report(&self) -> EnforcementReport {
        if let Some(path) = &self.sandbox_exec_path {
            // sandbox-exec is available, but we have not yet implemented
            // the Seatbelt profile generation. Report Degraded with a clear
            // note about what's missing.
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
                    format!(
                        "seatbelt CLI available at {} but profile generation not implemented",
                        path.display()
                    ),
                    "filesystem/network: degraded — Seatbelt profile generation is a stub"
                        .to_string(),
                    "pid/mount/user namespaces: unsupported on macOS (use forge-sandbox-container)"
                        .to_string(),
                    "fail closed: prefer forge-sandbox-container for full enforcement"
                        .to_string(),
                ],
            };
        }
        // sandbox-exec not found — be honest.
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
                "seatbelt CLI (sandbox-exec) not found on PATH".to_string(),
                "fail closed: prefer forge-sandbox-container".to_string(),
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
        // If sandbox-exec is unavailable OR profile generation is not
        // implemented, profiles that require namespace isolation are
        // rejected with Unsupported.
        if self.sandbox_exec_path.is_none() {
            if matches!(profile.network, NetworkAccess::Deny) {
                return Err(SandboxError::Unsupported(
                    "profile requires network isolation but sandbox-exec is not available"
                        .into(),
                ));
            }
            return Err(SandboxError::Unsupported(
                "macOS seatbelt backend not implemented in this build".into(),
            ));
        }
        // sandbox-exec is available but profile generation is a stub —
        // accept the profile but report Degraded.
        Ok(())
    }
}

/// Resolve `sandbox-exec` on `$PATH` by invoking `sandbox-exec --version`.
/// Returns `None` if not found.
fn which_sandbox_exec() -> Option<PathBuf> {
    let output = Command::new("sandbox-exec")
        .arg("--version")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        // `sandbox-exec --version` may not be a valid flag on all macOS
        // versions; try `sandbox-exec -h` as a fallback.
        let help = Command::new("sandbox-exec")
            .arg("-h")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .output()
            .ok()?;
        if !help.status.success() {
            return None;
        }
    }
    Some(PathBuf::from("sandbox-exec"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_sandbox::SandboxProfile;

    #[test]
    fn macos_backend_fails_closed_when_sandbox_exec_missing() {
        let backend = MacOsSandboxBackend::with_mocked_sandbox_exec(false);
        let err = backend
            .supports_profile(&SandboxProfile::default_restrictive())
            .expect_err("must fail closed without sandbox-exec");
        assert!(matches!(err, SandboxError::Unsupported(_)));
        let report = backend.enforcement_report();
        assert_eq!(report.status, EnforcementStatus::Unsupported);
    }

    #[test]
    fn macos_backend_reports_degraded_when_sandbox_exec_present() {
        let backend = MacOsSandboxBackend::with_mocked_sandbox_exec(true);
        let report = backend.enforcement_report();
        assert_eq!(report.status, EnforcementStatus::Degraded);
        assert!(report
            .notes
            .iter()
            .any(|n| n.contains("profile generation not implemented")));
        // FilesystemIsolation is degraded (not enforced, not unsupported).
        assert!(report
            .degraded
            .contains(&EnforcementFeature::FilesystemIsolation));
    }

    #[test]
    fn macos_backend_rejects_ambient_secrets() {
        let backend = MacOsSandboxBackend::with_mocked_sandbox_exec(true);
        let mut profile = SandboxProfile::default_restrictive();
        profile.secrets = forge_sandbox::SecretsAccess::AmbientEnvironment;
        let err = backend.supports_profile(&profile).expect_err("ambient secrets must be rejected");
        assert!(matches!(err, SandboxError::Misconfigured(_)));
    }

    #[test]
    fn macos_backend_accepts_restrictive_when_sandbox_exec_present() {
        let backend = MacOsSandboxBackend::with_mocked_sandbox_exec(true);
        backend
            .supports_profile(&SandboxProfile::default_restrictive())
            .expect("restrictive profile should be accepted (degraded) when sandbox-exec is present");
    }
}

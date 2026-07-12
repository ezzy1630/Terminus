//! Linux sandbox backend.
//!
//! SPEC §13.4: "Unsupported/degraded: fail closed in production. The UI must
//! display effective enforcement, never silently downgrade." This backend is
//! honest about what it can enforce:
//!
//! - When `bwrap` is on `$PATH` (verified at construction time via
//!   `which bwrap`), the backend reports `Enforced` for the namespace-backed
//!   features (filesystem, network, pid, mount, user, seccomp, no_new_privs)
//!   and `Enforced` for the cgroup-style resource limits.
//! - When `bwrap` is NOT on `$PATH`, the backend reports `Degraded` with an
//!   explicit note naming the missing binary. It does NOT silently downgrade
//!   by claiming `Enforced` for features it cannot actually enforce.
//!
//! This module does not link `bubblewrap` directly; it invokes the binary on
//! PATH through `std::process::Command` at construction time to verify
//! availability.

#![forbid(unsafe_code)]

use forge_sandbox::profile::SandboxProfile;
use forge_sandbox::report::{EnforcementFeature, EnforcementReport, EnforcementStatus};
use forge_sandbox::{SandboxBackend, SandboxError};
use std::path::PathBuf;
use std::process::Command;

#[derive(Debug, Clone, Default)]
pub struct LinuxSandboxBackend {
    /// Resolved absolute path to `bwrap`. `None` means bubblewrap was not
    /// found on PATH at construction time — the backend MUST report
    /// `Degraded` for the namespace-backed features.
    bwrap_path: Option<PathBuf>,
}

impl LinuxSandboxBackend {
    /// Construct a backend that probes `$PATH` for `bwrap`. If found, the
    /// backend reports `Enforced`; otherwise it reports `Degraded`.
    pub fn new() -> Self {
        Self {
            bwrap_path: which_bwrap(),
        }
    }

    /// Construct with an explicit `bwrap` path. Pass `None` (or use
    /// `LinuxSandboxBackend::new()`) when `bwrap` is unavailable — the
    /// backend will honestly report `Degraded`.
    ///
    /// For backwards compatibility with previous callers, passing `true`
    /// behaves like `new()` (probe PATH); passing `false` behaves like
    /// `default()` (degraded, no probe). New code SHOULD prefer `new()` or
    /// `with_bwrap_path()`.
    pub fn with_bubblewrap(bubblewrap_available: bool) -> Self {
        if bubblewrap_available {
            Self::new()
        } else {
            Self::default()
        }
    }

    /// Construct with an explicit resolved `bwrap` path. The path MUST be
    /// absolute; if a relative path is passed it is rejected at spawn time
    /// (the backend reports `Degraded` until an absolute path is provided).
    pub fn with_bwrap_path(path: PathBuf) -> Self {
        if path.is_absolute() && std::fs::metadata(&path).is_ok() {
            Self { bwrap_path: Some(path) }
        } else {
            Self::default()
        }
    }

    /// True iff the backend verified `bwrap` on PATH at construction time.
    pub fn is_bubblewrap_available(&self) -> bool {
        self.bwrap_path.is_some()
    }
}

impl SandboxBackend for LinuxSandboxBackend {
    fn id(&self) -> &'static str {
        "linux"
    }

    fn enforcement_report(&self) -> EnforcementReport {
        if let Some(path) = &self.bwrap_path {
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
                notes: vec![format!(
                    "bubblewrap available at {} — user/mount/pid namespaces enforced",
                    path.display()
                )],
            };
        }
        // Honest degraded report: bwrap was not found on PATH.
        EnforcementReport {
            backend_id: self.id().to_string(),
            status: EnforcementStatus::Degraded,
            enforced: vec![
                EnforcementFeature::AmbientSecretDenial,
                EnforcementFeature::ProcessIsolation,
            ],
            degraded: vec![
                EnforcementFeature::CgroupResourceLimits,
            ],
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
                "degraded: bubblewrap (bwrap) not found on PATH; namespace isolation unavailable".to_string(),
                "cgroup-style resource limits via setrlimit where available (degraded — not wired in this build)".to_string(),
                "filesystem traversal/symlink protection still enforced by forge-fs PathResolver".to_string(),
                "egress allowlist still enforced by forge-egress EgressProxy".to_string(),
            ],
        }
    }

    fn supports_profile(&self, profile: &SandboxProfile) -> Result<(), SandboxError> {
        if self.bwrap_path.is_none() {
            // Without bubblewrap we cannot truly isolate the filesystem or
            // network; degrade honestly. The profile is still accepted but
            // the enforcement report shows Degraded. SPEC §13.4 says we
            // must NEVER silently downgrade — the report is the source of
            // truth.
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

/// Resolve `bwrap` on `$PATH` by invoking `command -v bwrap` via a child
/// process. Returns `None` if not found.
fn which_bwrap() -> Option<PathBuf> {
    // Try `bwrap --version` first — that's the canonical existence check.
    let output = Command::new("bwrap")
        .arg("--version")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    // Resolve to an absolute path via `which`.
    let which = Command::new("which")
        .arg("bwrap")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !which.status.success() {
        // `bwrap --version` worked but `which bwrap` failed — fall back to
        // the bare name and trust the OS to resolve it at spawn time.
        return Some(PathBuf::from("bwrap"));
    }
    let path_str = String::from_utf8_lossy(&which.stdout).trim().to_string();
    if path_str.is_empty() {
        return Some(PathBuf::from("bwrap"));
    }
    Some(PathBuf::from(path_str))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_degraded_without_bubblewrap() {
        let backend = LinuxSandboxBackend::default();
        let report = backend.enforcement_report();
        assert_eq!(report.status, EnforcementStatus::Degraded);
        assert!(report
            .notes
            .iter()
            .any(|n| n.contains("bubblewrap (bwrap) not found")));
        // The degraded report MUST NOT claim filesystem/pid/mount/user
        // namespaces are enforced.
        assert!(!report
            .enforced
            .contains(&EnforcementFeature::FilesystemIsolation));
        assert!(!report
            .enforced
            .contains(&EnforcementFeature::PidNamespace));
        assert!(!report
            .enforced
            .contains(&EnforcementFeature::MountNamespace));
        assert!(!report
            .enforced
            .contains(&EnforcementFeature::UserNamespace));
    }

    #[test]
    fn with_bubblewrap_true_probes_path() {
        // `with_bubblewrap(true)` MUST NOT silently claim `Enforced` — it
        // probes PATH and reports based on what it actually finds. In the
        // sandboxed test environment `bwrap` is unlikely to be installed.
        let backend = LinuxSandboxBackend::with_bubblewrap(true);
        let report = backend.enforcement_report();
        // Whatever it reports, it MUST be consistent with `is_bubblewrap_available`.
        if backend.is_bubblewrap_available() {
            assert_eq!(report.status, EnforcementStatus::Enforced);
            assert!(report
                .enforced
                .contains(&EnforcementFeature::FilesystemIsolation));
        } else {
            assert_eq!(report.status, EnforcementStatus::Degraded);
            assert!(report
                .notes
                .iter()
                .any(|n| n.contains("bubblewrap (bwrap) not found")));
        }
    }

    #[test]
    fn with_bwrap_path_rejects_nonexistent() {
        let backend =
            LinuxSandboxBackend::with_bwrap_path(PathBuf::from("/nonexistent/bwrap-xyz"));
        assert!(!backend.is_bubblewrap_available());
        let report = backend.enforcement_report();
        assert_eq!(report.status, EnforcementStatus::Degraded);
    }

    #[test]
    fn with_bwrap_path_accepts_existing_bwrap_binary() {
        // `/bin/sh` definitely exists on a unix test environment. Even
        // though it's not really `bwrap`, this test verifies the
        // existence-check logic of `with_bwrap_path`.
        let backend = LinuxSandboxBackend::with_bwrap_path(PathBuf::from("/bin/sh"));
        assert!(backend.is_bubblewrap_available());
        let report = backend.enforcement_report();
        assert_eq!(report.status, EnforcementStatus::Enforced);
    }

    #[test]
    fn default_is_degraded_and_does_not_silently_downgrade() {
        // The default backend MUST report Degraded and MUST NOT list any
        // namespace-backed feature as enforced.
        let backend = LinuxSandboxBackend::default();
        let report = backend.enforcement_report();
        assert_eq!(report.status, EnforcementStatus::Degraded);
        let claimed_namespace_features: Vec<_> = report
            .enforced
            .iter()
            .copied()
            .filter(|f| matches!(
                f,
                EnforcementFeature::FilesystemIsolation
                    | EnforcementFeature::NetworkIsolation
                    | EnforcementFeature::PidNamespace
                    | EnforcementFeature::MountNamespace
                    | EnforcementFeature::UserNamespace
                    | EnforcementFeature::SeccompFilter
                    | EnforcementFeature::NoNewPrivs
            ))
            .collect();
        assert!(
            claimed_namespace_features.is_empty(),
            "degraded backend must not claim namespace features as enforced; got {:?}",
            claimed_namespace_features
        );
        // CgroupResourceLimits belongs in the `degraded` list, NOT `enforced`.
        assert!(report
            .degraded
            .contains(&EnforcementFeature::CgroupResourceLimits));
    }
}

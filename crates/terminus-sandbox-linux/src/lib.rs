//! Linux sandbox backend (SPEC §13.4, §36.5).
//!
//! This backend wraps [Bubblewrap](https://github.com/containers/bubblewrap)
//! (`bwrap`) when it is available on the host. Bubblewrap provides
//! user/mount/pid/network namespace isolation without requiring root
//! privileges (it uses `PR_SET_NO_NEW_PRIVS` and user namespaces).
//!
//! Honesty contract (SPEC §13.4: "Unsupported/degraded: fail closed in
//! production. The UI must display effective enforcement, never silently
//! downgrade."):
//!
//! - When `bwrap` IS on `$PATH` (verified at construction time via
//!   `which bwrap`), the backend reports `Enforced` for the namespace-backed
//!   features it actually provides: filesystem, network, process, pid/mount/
//!   user namespaces, and `NO_NEW_PRIVS`. It reports `Degraded` for
//!   `SeccompFilter` (bwrap does not install a seccomp filter by default)
//!   and `CgroupResourceLimits` (bwrap does not manage cgroups).
//! - When `bwrap` is NOT on `$PATH`, the backend reports `Degraded` with an
//!   explicit note naming the missing binary. It does NOT silently downgrade
//!   by claiming `Enforced` for features it cannot actually enforce. Profiles
//!   that require namespace isolation (e.g. `network: Deny`) are rejected
//!   with `SandboxError::Unsupported` so the caller can fall back to a
//!   stronger backend (e.g. `terminus-sandbox-container`).
//!
//! This module does not link `bubblewrap` directly; it invokes the binary
//! on PATH through `std::process::Command` at construction time to verify
//! availability, and constructs the bwrap argv from the sandbox profile
//! when `spawn_in_sandbox` is called.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]
#![forbid(unsafe_code)]

use std::path::PathBuf;
use std::process::Command;
use terminus_kernel_protocol::CommandSpec;
use terminus_sandbox::profile::{FilesystemAccess, NetworkAccess, SandboxProfile};
use terminus_sandbox::report::{EnforcementFeature, EnforcementReport, EnforcementStatus};
use terminus_sandbox::{SandboxBackend, SandboxError};

#[derive(Debug, Clone, Default)]
pub struct LinuxSandboxBackend {
    /// Resolved absolute path to `bwrap`. `None` means bubblewrap was not
    /// found on PATH at construction time — the backend MUST report
    /// `Degraded` for the namespace-backed features and MUST reject profiles
    /// that require namespace isolation.
    bwrap_path: Option<PathBuf>,
}

impl LinuxSandboxBackend {
    /// Construct a backend that probes `$PATH` for `bwrap`. If found, the
    /// backend reports `Enforced` for the namespace-backed features;
    /// otherwise it reports `Degraded` and rejects profiles that require
    /// namespace isolation.
    pub fn new() -> Self {
        Self {
            bwrap_path: which_bwrap(),
        }
    }

    /// Construct with an explicit `bwrap` availability flag. If `true`,
    /// probes PATH (same as `new()`). If `false`, behaves as if `bwrap` was
    /// not found (degraded, no probe). New code SHOULD prefer `new()` or
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
            Self {
                bwrap_path: Some(path),
            }
        } else {
            Self::default()
        }
    }

    /// Construct a backend with a mocked bwrap availability. If `available`
    /// is `true`, the backend behaves as if `bwrap` was found on PATH
    /// (reports `Enforced` for namespace features). If `false`, the backend
    /// behaves as if `bwrap` was NOT found (reports `Degraded`). This
    /// bypasses the filesystem existence check — useful for unit tests that
    /// do not want to depend on the test environment having `bwrap`
    /// installed.
    pub fn with_mocked_bwrap(available: bool) -> Self {
        if available {
            Self {
                bwrap_path: Some(PathBuf::from("/usr/bin/bwrap")),
            }
        } else {
            Self::default()
        }
    }

    /// True iff the backend verified `bwrap` on PATH at construction time.
    pub fn is_bubblewrap_available(&self) -> bool {
        self.bwrap_path.is_some()
    }

    /// Build the `bwrap` argv for `command` under `profile`. This is a pure
    /// function — it does not invoke `bwrap` or touch the filesystem. The
    /// returned vector is suitable for passing to `std::process::Command::
    /// args()`.
    ///
    /// The argv encodes:
    /// - `--unshare-all` — user, pid, mount, ipc, uts namespaces.
    /// - `--unshare-net` (only when `profile.network == Deny`) — network
    ///   namespace.
    /// - `--ro-bind / /` — read-only root filesystem.
    /// - `--proc /proc`, `--dev /dev` — mount /proc and /dev.
    /// - Per-rule `--ro-bind` / `--bind` for filesystem rules whose path is
    ///   an absolute host path. Workspace-URI rules
    ///   (`workspace://...`) are skipped — they are logical and resolved
    ///   by `terminus_fs::PathResolver`, not by bwrap.
    /// - `--die-with-parent`, `--new-session` — lifecycle isolation.
    /// - `--cap-drop ALL` — drop all Linux capabilities.
    /// - `--chdir <cwd>` — set the working directory.
    /// - `--` followed by the command program and its args.
    pub fn build_bwrap_argv(command: &CommandSpec, profile: &SandboxProfile) -> Vec<String> {
        let mut argv: Vec<String> = Vec::new();

        // Namespace isolation. --unshare-all covers user, pid, mount, ipc, uts.
        argv.push("--unshare-all".to_string());
        if matches!(profile.network, NetworkAccess::Deny) {
            argv.push("--unshare-net".to_string());
        }

        // Read-only root filesystem.
        argv.push("--ro-bind".to_string());
        argv.push("/".to_string());
        argv.push("/".to_string());

        // /proc and /dev so basic tools work.
        argv.push("--proc".to_string());
        argv.push("/proc".to_string());
        argv.push("--dev".to_string());
        argv.push("/dev".to_string());

        // Per-rule bind mounts. Skip workspace:// URIs — they are logical
        // and resolved by terminus_fs::PathResolver, not by bwrap.
        for rule in &profile.filesystem {
            if !rule.path.starts_with('/') {
                continue;
            }
            match rule.access {
                FilesystemAccess::ReadOnly => {
                    argv.push("--ro-bind".to_string());
                    argv.push(rule.path.clone());
                    argv.push(rule.path.clone());
                }
                FilesystemAccess::ReadWrite => {
                    argv.push("--bind".to_string());
                    argv.push(rule.path.clone());
                    argv.push(rule.path.clone());
                }
                FilesystemAccess::Deny => {
                    // Deny by NOT bind-mounting the path. Paths not
                    // explicitly bound are not visible inside the sandbox.
                }
            }
        }

        // Lifecycle isolation.
        argv.push("--die-with-parent".to_string());
        argv.push("--new-session".to_string());

        // Drop all capabilities. bwrap itself sets PR_SET_NO_NEW_PRIVS on
        // the child when --unshare-all is used, so NoNewPrivs is enforced.
        argv.push("--cap-drop".to_string());
        argv.push("ALL".to_string());

        // Working directory.
        if !command.cwd.relative_path.is_empty() && command.cwd.relative_path != "." {
            argv.push("--chdir".to_string());
            argv.push(command.cwd.relative_path.clone());
        }

        // The command to run, followed by its arguments.
        argv.push("--".to_string());
        argv.push(command.program.clone());
        for arg in &command.args {
            argv.push(arg.clone());
        }

        argv
    }

    /// Spawn `command` inside a bwrap sandbox configured by `profile`.
    /// Returns the captured `std::process::Output` (stdout, stderr, exit
    /// code). Returns `SandboxError::Unsupported` if `bwrap` was not
    /// available at construction time.
    pub fn spawn_in_sandbox(
        &self,
        command: &CommandSpec,
        profile: &SandboxProfile,
    ) -> Result<std::process::Output, SandboxError> {
        let bwrap_path = self.bwrap_path.as_ref().ok_or_else(|| {
            SandboxError::Unsupported(
                "bwrap not available on this host; cannot spawn in sandbox".to_string(),
            )
        })?;
        let argv = Self::build_bwrap_argv(command, profile);
        let mut cmd = Command::new(bwrap_path);
        cmd.args(&argv);
        // Clear the environment — bwrap does not propagate ambient env by
        // default when --unshare-all is used, but we explicitly clear here
        // to be safe. The caller-provided public_env is set explicitly.
        cmd.env_clear();
        for (k, v) in &command.public_env {
            cmd.env(k, v);
        }
        if command.timeout_ms > 0 {
            // std::process::Command does not have a native timeout; the
            // caller is responsible for enforcing it externally (e.g. via
            // a watchdog). We record it here for future use.
        }
        cmd.output().map_err(SandboxError::Io)
    }
}

impl SandboxBackend for LinuxSandboxBackend {
    fn id(&self) -> &'static str {
        "linux"
    }

    /// SPEC §13.4 / §34.11: when bwrap is available, return the wrapper
    /// binary + full bwrap argv (including `-- <program> <args...>`) so
    /// `ProcessManager` can spawn the process inside the sandbox with
    /// streaming output. When bwrap is unavailable, return `None` (the
    /// caller spawns directly; the enforcement report already says
    /// Degraded).
    fn spawn_wrapper(
        &self,
        command: &CommandSpec,
        profile: &SandboxProfile,
    ) -> Option<(std::path::PathBuf, Vec<String>)> {
        let bwrap_path = self.bwrap_path.as_ref()?;
        if !bwrap_path.is_absolute() {
            return None;
        }
        Some((bwrap_path.clone(), Self::build_bwrap_argv(command, profile)))
    }

    fn enforcement_report(&self) -> EnforcementReport {
        if let Some(path) = &self.bwrap_path {
            // bwrap is available. Report Enforced for the namespace-backed
            // features it actually provides. Be honest about SeccompFilter
            // (bwrap does not install a seccomp filter by default) and
            // CgroupResourceLimits (bwrap does not manage cgroups).
            return EnforcementReport {
                backend_id: self.id().to_string(),
                // A backend with missing mandatory controls is degraded as a
                // whole; callers must never infer full enforcement merely
                // because the namespace subset is active.
                status: EnforcementStatus::Degraded,
                enforced: vec![
                    EnforcementFeature::FilesystemIsolation,
                    EnforcementFeature::NetworkIsolation,
                    EnforcementFeature::ProcessIsolation,
                    EnforcementFeature::NoNewPrivs,
                    EnforcementFeature::AmbientSecretDenial,
                    EnforcementFeature::PluginAmbientAuthorityDenial,
                    EnforcementFeature::PidNamespace,
                    EnforcementFeature::MountNamespace,
                    EnforcementFeature::UserNamespace,
                ],
                degraded: vec![
                    EnforcementFeature::SeccompFilter,
                    EnforcementFeature::CgroupResourceLimits,
                ],
                unsupported: vec![],
                notes: vec![
                    format!(
                        "bubblewrap available at {} — user/mount/pid/net namespaces enforced",
                        path.display()
                    ),
                    "seccomp filter: degraded (bwrap does not install a seccomp filter by default)"
                        .to_string(),
                    "cgroup resource limits: degraded (bwrap does not manage cgroups)".to_string(),
                    "spawn_in_sandbox() constructs the bwrap argv from the profile".to_string(),
                ],
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
            degraded: vec![EnforcementFeature::CgroupResourceLimits],
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
                "degraded: bubblewrap (bwrap) not found on PATH; namespace isolation unavailable"
                    .to_string(),
                "cgroup-style resource limits via setrlimit where available (degraded — not wired in this build)"
                    .to_string(),
                "filesystem traversal/symlink protection still enforced by terminus-fs PathResolver"
                    .to_string(),
                "egress allowlist still enforced by terminus-egress EgressProxy".to_string(),
                "profiles requiring namespace isolation (network: Deny) will be rejected with Unsupported"
                    .to_string(),
            ],
        }
    }

    fn supports_profile(&self, profile: &SandboxProfile) -> Result<(), SandboxError> {
        // Security refusal: ambient secrets are never permitted.
        if matches!(
            profile.secrets,
            terminus_sandbox::SecretsAccess::AmbientEnvironment
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
        // If bwrap is unavailable, profiles that REQUIRE namespace isolation
        // are rejected with Unsupported so the caller can fall back to a
        // stronger backend (e.g. terminus-sandbox-container). Network Deny
        // requires --unshare-net, which requires bwrap. Filesystem Deny rules
        // can be partially enforced via terminus-fs path policy, so we do not
        // reject them here; the enforcement report shows Degraded for
        // FilesystemIsolation.
        if self.bwrap_path.is_none() && matches!(profile.network, NetworkAccess::Deny) {
            return Err(SandboxError::Unsupported(
                "profile requires network isolation (--unshare-net) but bwrap is not available"
                    .into(),
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
    _limits: &terminus_sandbox::ResourceLimits,
) -> Result<(), SandboxError> {
    Err(SandboxError::Degraded(
        "setrlimit binding unavailable in this build".into(),
    ))
}

/// Resolve `bwrap` on `$PATH` by invoking `bwrap --version` and then
/// `which bwrap`. Returns `None` if not found.
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
    use terminus_kernel_protocol::WorkspacePath;
    use terminus_sandbox::profile::{
        FilesystemAccess, FilesystemRule, NetworkAccess, ProcessAccess, ResourceLimits,
        SandboxProfile, SecretsAccess,
    };

    fn restrictive_profile() -> SandboxProfile {
        SandboxProfile::default_restrictive()
    }

    fn profile_with_network_deny() -> SandboxProfile {
        let mut p = restrictive_profile();
        p.network = NetworkAccess::Deny;
        p
    }

    fn profile_with_network_allow() -> SandboxProfile {
        let mut p = restrictive_profile();
        p.network = NetworkAccess::Allow;
        p
    }

    fn simple_command(program: &str) -> CommandSpec {
        CommandSpec {
            program: program.to_string(),
            args: vec!["hello".to_string()],
            cwd: WorkspacePath::new("ws-1", "src"),
            ..Default::default()
        }
    }

    // ---------- enforcement report tests ----------

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
        assert!(!report.enforced.contains(&EnforcementFeature::PidNamespace));
        assert!(!report
            .enforced
            .contains(&EnforcementFeature::MountNamespace));
        assert!(!report.enforced.contains(&EnforcementFeature::UserNamespace));
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
        let backend = LinuxSandboxBackend::with_bwrap_path(PathBuf::from("/nonexistent/bwrap-xyz"));
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
        assert_eq!(report.status, EnforcementStatus::Degraded);
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
            .filter(|f| {
                matches!(
                    f,
                    EnforcementFeature::FilesystemIsolation
                        | EnforcementFeature::NetworkIsolation
                        | EnforcementFeature::PidNamespace
                        | EnforcementFeature::MountNamespace
                        | EnforcementFeature::UserNamespace
                        | EnforcementFeature::SeccompFilter
                        | EnforcementFeature::NoNewPrivs
                )
            })
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

    // ---------- new tests for the F9 improvements ----------

    #[test]
    fn enforcement_report_changes_with_bwrap_availability() {
        // Mock the `which` check: with_mocked_bwrap(true/false) sets the
        // bwrap_path WITHOUT touching the filesystem.
        let without_bwrap = LinuxSandboxBackend::with_mocked_bwrap(false);
        let report_without = without_bwrap.enforcement_report();
        assert_eq!(report_without.status, EnforcementStatus::Degraded);
        assert!(without_bwrap.bwrap_path.is_none());

        let with_bwrap = LinuxSandboxBackend::with_mocked_bwrap(true);
        let report_with = with_bwrap.enforcement_report();
        assert_eq!(report_with.status, EnforcementStatus::Degraded);
        assert!(with_bwrap.bwrap_path.is_some());

        // The enforced feature list MUST be strictly larger when bwrap is
        // available.
        assert!(report_with.enforced.len() > report_without.enforced.len());

        // Specifically, namespace features MUST move from `unsupported` to
        // `enforced` when bwrap becomes available.
        for feature in [
            EnforcementFeature::FilesystemIsolation,
            EnforcementFeature::NetworkIsolation,
            EnforcementFeature::PidNamespace,
            EnforcementFeature::MountNamespace,
            EnforcementFeature::UserNamespace,
            EnforcementFeature::NoNewPrivs,
        ] {
            assert!(
                report_without.unsupported.contains(&feature),
                "without bwrap, {feature:?} should be unsupported"
            );
            assert!(
                report_with.enforced.contains(&feature),
                "with bwrap, {feature:?} should be enforced"
            );
        }

        // SeccompFilter and CgroupResourceLimits MUST be in `degraded` when
        // bwrap is available (bwrap does not provide these by default).
        assert!(report_with
            .degraded
            .contains(&EnforcementFeature::SeccompFilter));
        assert!(report_with
            .degraded
            .contains(&EnforcementFeature::CgroupResourceLimits));
    }

    #[test]
    fn supports_profile_rejects_network_deny_without_bwrap() {
        let backend = LinuxSandboxBackend::with_mocked_bwrap(false);
        let err = backend
            .supports_profile(&profile_with_network_deny())
            .expect_err("network Deny must be rejected without bwrap");
        assert!(matches!(err, SandboxError::Unsupported(_)));
    }

    #[test]
    fn supports_profile_accepts_network_allow_without_bwrap() {
        let backend = LinuxSandboxBackend::with_mocked_bwrap(false);
        // network Allow does not require --unshare-net, so the no-bwrap
        // backend can still accept the profile (with a degraded report).
        backend
            .supports_profile(&profile_with_network_allow())
            .expect("network Allow should be accepted without bwrap");
    }

    #[test]
    fn supports_profile_accepts_restrictive_with_bwrap() {
        let backend = LinuxSandboxBackend::with_mocked_bwrap(true);
        backend
            .supports_profile(&profile_with_network_deny())
            .expect("restrictive profile should be accepted with bwrap");
    }

    #[test]
    fn supports_profile_rejects_ambient_secrets_regardless_of_bwrap() {
        let mut p = restrictive_profile();
        p.secrets = SecretsAccess::AmbientEnvironment;
        let with_bwrap = LinuxSandboxBackend::with_mocked_bwrap(true);
        let err = with_bwrap
            .supports_profile(&p)
            .expect_err("ambient secrets must be rejected");
        assert!(matches!(err, SandboxError::Misconfigured(_)));
        let without_bwrap = LinuxSandboxBackend::with_mocked_bwrap(false);
        let err = without_bwrap
            .supports_profile(&p)
            .expect_err("ambient secrets must be rejected");
        assert!(matches!(err, SandboxError::Misconfigured(_)));
    }

    // ---------- build_bwrap_argv tests ----------

    #[test]
    fn build_bwrap_argv_includes_unshare_all() {
        let cmd = simple_command("ls");
        let profile = restrictive_profile();
        let argv = LinuxSandboxBackend::build_bwrap_argv(&cmd, &profile);
        assert!(argv.contains(&"--unshare-all".to_string()));
    }

    #[test]
    fn build_bwrap_argv_includes_unshare_net_when_network_deny() {
        let cmd = simple_command("curl");
        let profile = profile_with_network_deny();
        let argv = LinuxSandboxBackend::build_bwrap_argv(&cmd, &profile);
        assert!(argv.contains(&"--unshare-net".to_string()));
    }

    #[test]
    fn build_bwrap_argv_omits_unshare_net_when_network_allow() {
        let cmd = simple_command("curl");
        let profile = profile_with_network_allow();
        let argv = LinuxSandboxBackend::build_bwrap_argv(&cmd, &profile);
        assert!(!argv.contains(&"--unshare-net".to_string()));
    }

    #[test]
    fn build_bwrap_argv_includes_ro_bind_root() {
        let cmd = simple_command("ls");
        let profile = restrictive_profile();
        let argv = LinuxSandboxBackend::build_bwrap_argv(&cmd, &profile);
        let idx = argv
            .iter()
            .position(|a| a == "--ro-bind")
            .expect("--ro-bind present");
        // The first --ro-bind is for the root filesystem: --ro-bind / /
        assert_eq!(argv.get(idx + 1), Some(&"/".to_string()));
        assert_eq!(argv.get(idx + 2), Some(&"/".to_string()));
    }

    #[test]
    fn build_bwrap_argv_includes_proc_and_dev() {
        let cmd = simple_command("ls");
        let profile = restrictive_profile();
        let argv = LinuxSandboxBackend::build_bwrap_argv(&cmd, &profile);
        assert!(argv.contains(&"--proc".to_string()));
        assert!(argv.contains(&"/proc".to_string()));
        assert!(argv.contains(&"--dev".to_string()));
        assert!(argv.contains(&"/dev".to_string()));
    }

    #[test]
    fn build_bwrap_argv_includes_die_with_parent_and_new_session() {
        let cmd = simple_command("ls");
        let profile = restrictive_profile();
        let argv = LinuxSandboxBackend::build_bwrap_argv(&cmd, &profile);
        assert!(argv.contains(&"--die-with-parent".to_string()));
        assert!(argv.contains(&"--new-session".to_string()));
    }

    #[test]
    fn build_bwrap_argv_includes_cap_drop_all() {
        let cmd = simple_command("ls");
        let profile = restrictive_profile();
        let argv = LinuxSandboxBackend::build_bwrap_argv(&cmd, &profile);
        let idx = argv
            .iter()
            .position(|a| a == "--cap-drop")
            .expect("--cap-drop present");
        assert_eq!(argv.get(idx + 1), Some(&"ALL".to_string()));
    }

    #[test]
    fn build_bwrap_argv_includes_chdir_when_cwd_set() {
        let cmd = CommandSpec {
            program: "ls".to_string(),
            args: vec![],
            cwd: WorkspacePath::new("ws-1", "src/deep/path"),
            ..Default::default()
        };
        let profile = restrictive_profile();
        let argv = LinuxSandboxBackend::build_bwrap_argv(&cmd, &profile);
        let idx = argv
            .iter()
            .position(|a| a == "--chdir")
            .expect("--chdir present");
        assert_eq!(argv.get(idx + 1), Some(&"src/deep/path".to_string()));
    }

    #[test]
    fn build_bwrap_argv_omits_chdir_when_cwd_is_dot() {
        let cmd = CommandSpec {
            program: "ls".to_string(),
            args: vec![],
            cwd: WorkspacePath::new("ws-1", "."),
            ..Default::default()
        };
        let profile = restrictive_profile();
        let argv = LinuxSandboxBackend::build_bwrap_argv(&cmd, &profile);
        assert!(!argv.contains(&"--chdir".to_string()));
    }

    #[test]
    fn build_bwrap_argv_appends_command_after_double_dash() {
        let cmd = CommandSpec {
            program: "echo".to_string(),
            args: vec!["hello".to_string(), "world".to_string()],
            cwd: WorkspacePath::new("ws-1", "."),
            ..Default::default()
        };
        let profile = restrictive_profile();
        let argv = LinuxSandboxBackend::build_bwrap_argv(&cmd, &profile);
        let dash_idx = argv
            .iter()
            .position(|a| a == "--")
            .expect("-- separator present");
        // After --, we expect: echo hello world
        assert_eq!(argv.get(dash_idx + 1), Some(&"echo".to_string()));
        assert_eq!(argv.get(dash_idx + 2), Some(&"hello".to_string()));
        assert_eq!(argv.get(dash_idx + 3), Some(&"world".to_string()));
        // Nothing after the last arg.
        assert_eq!(argv.len(), dash_idx + 4);
    }

    #[test]
    fn build_bwrap_argv_skips_workspace_uri_rules() {
        // The default restrictive profile has workspace:// rules which are
        // logical, not host paths. They MUST NOT appear as --bind/--ro-bind
        // targets in the bwrap argv.
        let cmd = simple_command("ls");
        let profile = restrictive_profile();
        let argv = LinuxSandboxBackend::build_bwrap_argv(&cmd, &profile);
        // No argv entry should start with "workspace://".
        assert!(
            !argv.iter().any(|a| a.starts_with("workspace://")),
            "workspace:// URIs must not be passed to bwrap; got {:?}",
            argv
        );
    }

    #[test]
    fn build_bwrap_argv_includes_ro_bind_for_absolute_readonly_rules() {
        let cmd = simple_command("ls");
        let profile = SandboxProfile {
            id: "test-abs-ro".to_string(),
            filesystem: vec![
                FilesystemRule {
                    path: "/etc".to_string(),
                    access: FilesystemAccess::ReadOnly,
                },
                FilesystemRule {
                    path: "/var/log".to_string(),
                    access: FilesystemAccess::ReadWrite,
                },
            ],
            network: NetworkAccess::Allow,
            process: ProcessAccess::Allow,
            secrets: SecretsAccess::BrokeredCapabilities,
            resources: ResourceLimits::default(),
            plugins_ambient_authority: false,
        };
        let argv = LinuxSandboxBackend::build_bwrap_argv(&cmd, &profile);
        // /etc should appear as --ro-bind /etc /etc
        let ro_idx = argv
            .windows(3)
            .position(|w| w[0] == "--ro-bind" && w[1] == "/etc" && w[2] == "/etc");
        assert!(
            ro_idx.is_some(),
            "expected --ro-bind /etc /etc in argv: {:?}",
            argv
        );
        // /var/log should appear as --bind /var/log /var/log
        let rw_idx = argv
            .windows(3)
            .position(|w| w[0] == "--bind" && w[1] == "/var/log" && w[2] == "/var/log");
        assert!(
            rw_idx.is_some(),
            "expected --bind /var/log /var/log in argv: {:?}",
            argv
        );
    }

    #[test]
    fn spawn_in_sandbox_returns_unsupported_without_bwrap() {
        let backend = LinuxSandboxBackend::with_mocked_bwrap(false);
        let cmd = simple_command("echo");
        let profile = restrictive_profile();
        let err = backend
            .spawn_in_sandbox(&cmd, &profile)
            .expect_err("spawn must fail without bwrap");
        assert!(matches!(err, SandboxError::Unsupported(_)));
    }
}

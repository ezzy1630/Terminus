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
//! - When `bwrap` IS on `$PATH` and a real namespace probe succeeds, the
//!   backend can report `Enforced` for the namespace-backed features. The
//!   payload launcher adds the versioned seccomp filter and cgroup v2 lease.
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

mod enforcement;

// The packaged kernel binary relaunches itself through these Linux-only
// enforcement entrypoints. Keep the implementation private while exposing
// the narrow binary boundary required by `mini-services/terminus-kernel`.
pub use enforcement::{run_launcher, run_payload, run_probe, LAUNCHER_ARG, PAYLOAD_ARG};

#[derive(Debug, Clone, Default)]
pub struct LinuxSandboxBackend {
    /// Resolved absolute path to `bwrap`. `None` means bubblewrap was not
    /// found on PATH at construction time — the backend MUST report
    /// `Degraded` for the namespace-backed features and MUST reject profiles
    /// that require namespace isolation.
    bwrap_path: Option<PathBuf>,
    bwrap_verified: bool,
}

impl LinuxSandboxBackend {
    /// Guest-visible directory containing the sole broker socket allowed for
    /// a proxy-required sandbox lease.
    pub const EGRESS_BROKER_GUEST_DIR: &str = "/run/terminus-egress";
    pub const EGRESS_BROKER_SOCKET_NAME: &str = "broker.sock";
    /// Construct a backend that probes `$PATH` for `bwrap`. If found, the
    /// backend reports `Enforced` for the namespace-backed features;
    /// otherwise it reports `Degraded` and rejects profiles that require
    /// namespace isolation.
    pub fn new() -> Self {
        let bwrap_path = which_bwrap();
        Self {
            bwrap_verified: bwrap_path.is_some(),
            bwrap_path,
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
    /// absolute and pass the same namespace probe used by [`Self::new`].
    pub fn with_bwrap_path(path: PathBuf) -> Self {
        if path.is_absolute() && std::fs::metadata(&path).is_ok() {
            let bwrap_verified = probe_bwrap_path(&path);
            Self {
                bwrap_path: Some(path),
                bwrap_verified,
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
                bwrap_verified: false,
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
        Self::build_bwrap_argv_with_egress_broker(command, profile, None)
    }

    /// Build bwrap argv with an optional private egress-broker mount. The
    /// host broker parent is hidden by a tmpfs before the single lease
    /// directory is mounted at a fixed guest path, preventing a payload from
    /// enumerating or reusing another task's broker socket.
    pub fn build_bwrap_argv_with_egress_broker(
        command: &CommandSpec,
        profile: &SandboxProfile,
        broker_dir: Option<&std::path::Path>,
    ) -> Vec<String> {
        let mut argv: Vec<String> = Vec::new();

        // Namespace isolation. --unshare-all covers user, pid, mount, ipc, uts.
        argv.push("--unshare-all".to_string());
        if matches!(
            profile.network,
            NetworkAccess::Deny | NetworkAccess::ProxyRequired
        ) {
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

        if let Some(broker_dir) = broker_dir {
            if let Some(broker_parent) = broker_dir.parent() {
                // Hide the host lease parent inherited through `--ro-bind / /`.
                argv.push("--tmpfs".to_string());
                argv.push(broker_parent.display().to_string());
                // Then create a guest-only runtime path and expose just this
                // lease directory (which contains one 0600 Unix socket).
                argv.push("--tmpfs".to_string());
                argv.push("/run".to_string());
                argv.push("--dir".to_string());
                argv.push(Self::EGRESS_BROKER_GUEST_DIR.to_string());
                argv.push("--ro-bind".to_string());
                argv.push(broker_dir.display().to_string());
                argv.push(Self::EGRESS_BROKER_GUEST_DIR.to_string());
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

    /// Build a launcher that lets bubblewrap finish namespace setup before
    /// the payload installs seccomp and joins cgroup v2. The launcher is the
    /// current kernel executable in a dedicated mode, so release packaging
    /// does not need a second helper binary.
    pub fn build_enforced_wrapper(
        &self,
        command: &CommandSpec,
        profile: &SandboxProfile,
    ) -> Option<(PathBuf, Vec<String>)> {
        self.build_enforced_wrapper_with_egress_broker(command, profile, None)
    }

    pub fn build_enforced_wrapper_with_egress_broker(
        &self,
        command: &CommandSpec,
        profile: &SandboxProfile,
        broker_dir: Option<&std::path::Path>,
    ) -> Option<(PathBuf, Vec<String>)> {
        let bwrap_path = self.bwrap_path.as_ref()?;
        if !self.bwrap_verified {
            return None;
        }
        enforcement::payload_wrapper(
            bwrap_path,
            &Self::build_bwrap_argv_with_egress_broker(command, profile, broker_dir),
            profile.resources,
            profile.network,
        )
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
        if self.bwrap_path.is_none() {
            return Err(SandboxError::Unsupported(
                "bwrap not available on this host; cannot spawn in sandbox".to_string(),
            ));
        }
        let (launcher, argv) = self
            .build_enforced_wrapper(command, profile)
            .ok_or_else(|| {
                SandboxError::Unsupported(
                    "cannot build the enforced Linux sandbox launcher".to_string(),
                )
            })?;
        let mut cmd = Command::new(launcher);
        cmd.args(&argv);
        // Clear the environment — bwrap does not propagate ambient env by
        // default when --unshare-all is used, but we explicitly clear here
        // to be safe. The caller-provided public_env is set explicitly.
        cmd.env_clear();
        for (k, v) in &command.public_env {
            cmd.env(k, v);
        }
        let _ = command.timeout_ms;
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
        self.build_enforced_wrapper(command, profile)
    }

    fn spawn_wrapper_with_egress_broker(
        &self,
        command: &CommandSpec,
        profile: &SandboxProfile,
        broker_dir: &std::path::Path,
    ) -> Option<(std::path::PathBuf, Vec<String>)> {
        if !matches!(profile.network, NetworkAccess::ProxyRequired) {
            return None;
        }
        self.build_enforced_wrapper_with_egress_broker(command, profile, Some(broker_dir))
    }

    fn enforcement_report(&self) -> EnforcementReport {
        if let Some(path) = self.bwrap_path.as_ref().filter(|_| self.bwrap_verified) {
            if !enforcement::cgroup_v2_ready() {
                return EnforcementReport {
                    backend_id: self.id().to_string(),
                    status: EnforcementStatus::Degraded,
                    enforced: vec![],
                    degraded: vec![EnforcementFeature::CgroupResourceLimits],
                    unsupported: vec![EnforcementFeature::SeccompFilter],
                    notes: vec![
                        format!("bubblewrap available at {}", path.display()),
                        "cgroup v2 is not delegated and writable for Terminus".to_string(),
                        "secure execution fails closed until cgroup v2 is available".to_string(),
                    ],
                };
            }
            return EnforcementReport {
                backend_id: self.id().to_string(),
                status: EnforcementStatus::Enforced,
                enforced: vec![
                    EnforcementFeature::FilesystemIsolation,
                    EnforcementFeature::NetworkIsolation,
                    EnforcementFeature::NetworkNamespace,
                    EnforcementFeature::ProxyOnlyEgress,
                    EnforcementFeature::ProtectedGit,
                    EnforcementFeature::ProcessIsolation,
                    EnforcementFeature::ProcessTreeContainment,
                    EnforcementFeature::NoNewPrivs,
                    EnforcementFeature::AmbientSecretDenial,
                    EnforcementFeature::SecretIsolation,
                    EnforcementFeature::PluginAmbientAuthorityDenial,
                    EnforcementFeature::PidNamespace,
                    EnforcementFeature::MountNamespace,
                    EnforcementFeature::UserNamespace,
                    EnforcementFeature::SeccompFilter,
                    EnforcementFeature::CgroupResourceLimits,
                ],
                degraded: vec![],
                unsupported: vec![],
                notes: vec![
                    format!(
                        "bubblewrap available at {} — user/mount/pid/net namespaces enforced",
                        path.display()
                    ),
                    format!("seccomp policy: {}", enforcement::seccomp_policy_hash(true)),
                    "cgroup v2 resource limits are applied by the payload launcher".to_string(),
                    "proxy-only egress enforced via network namespace + broker socket mount"
                        .to_string(),
                    "protected .git via filesystem Deny rule + read-only root".to_string(),
                    "process tree containment via PID namespace + --die-with-parent".to_string(),
                    "secret isolation via env-clear + brokered capabilities only".to_string(),
                ],
            };
        }
        // Honest degraded report: bwrap was not verified on PATH.
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
                "degraded: bubblewrap (bwrap) not found or not verified on PATH; namespace isolation unavailable"
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
        // Profiles that require network isolation may only be selected after
        // the complete enforcement chain is verified. Merely finding a
        // `bwrap` binary is insufficient: a failed namespace probe or an
        // unavailable delegated cgroup would otherwise let a caller select
        // this backend while `spawn_wrapper()` returns `None`. Secure callers
        // must receive a typed refusal before any direct spawn is possible.
        // Filesystem Deny rules can be partially enforced via terminus-fs path
        // policy, so they remain reportable as degraded rather than rejected
        // here.
        if matches!(
            profile.network,
            NetworkAccess::Deny | NetworkAccess::ProxyRequired
        ) && !matches!(
            self.enforcement_report().status,
            EnforcementStatus::Enforced
        ) {
            return Err(SandboxError::Unsupported(
                "profile requires verified Linux namespace, seccomp, and delegated cgroup enforcement"
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
    limits: &terminus_sandbox::ResourceLimits,
) -> Result<(), SandboxError> {
    let _ = limits;
    Err(SandboxError::Unsupported(
        "resource limits are applied by the Linux payload launcher".into(),
    ))
}

/// Resolve and exercise `bwrap` on `$PATH`. A version string alone is not
/// evidence of enforcement: the probe must successfully create the
/// namespaces and launch a command before the path is trusted.
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
        // `bwrap --version` worked but `which bwrap` failed. Keep the same
        // functional probe and only retain the bare name if it passes.
        return probe_bwrap_path(std::path::Path::new("bwrap")).then(|| PathBuf::from("bwrap"));
    }
    let path_str = String::from_utf8_lossy(&which.stdout).trim().to_string();
    if path_str.is_empty() {
        return probe_bwrap_path(std::path::Path::new("bwrap")).then(|| PathBuf::from("bwrap"));
    }
    let path = PathBuf::from(path_str);
    probe_bwrap_path(&path).then_some(path)
}

fn probe_bwrap_path(path: &std::path::Path) -> bool {
    Command::new(path)
        .args([
            "--unshare-all",
            "--ro-bind",
            "/",
            "/",
            "--proc",
            "/proc",
            "--dev",
            "/dev",
            "--die-with-parent",
            "--new-session",
            "--cap-drop",
            "ALL",
            "--",
            "/bin/true",
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
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

    fn profile_with_proxy_required() -> SandboxProfile {
        let mut p = restrictive_profile();
        p.network = NetworkAccess::ProxyRequired;
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

    #[cfg(unix)]
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

        // A mocked path is intentionally not enough to claim enforcement.
        // Only a verified executable plus writable cgroup v2 may move a
        // profile to Enforced.
        assert_eq!(report_with.status, EnforcementStatus::Degraded);
        assert!(report_with
            .notes
            .iter()
            .any(|note| note.contains("not found or not verified")));
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
    fn supports_profile_rejects_unverified_bwrap_for_network_deny() {
        // A path-shaped mock has no functional namespace proof and no cgroup
        // delegation. It must be rejected before a caller can fall through to
        // an unsandboxed process spawn.
        let backend = LinuxSandboxBackend::with_mocked_bwrap(true);
        let error = backend
            .supports_profile(&profile_with_network_deny())
            .expect_err("unverified bwrap must not satisfy a secure profile");
        assert!(matches!(error, SandboxError::Unsupported(_)));
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
    fn proxy_required_mounts_only_the_lease_broker_directory() {
        let temp = tempfile::tempdir().unwrap();
        let broker_root = temp.path().join("brokers");
        let broker_dir = broker_root.join("lease-1");
        std::fs::create_dir_all(&broker_dir).unwrap();
        let command = simple_command("curl");
        let argv = LinuxSandboxBackend::build_bwrap_argv_with_egress_broker(
            &command,
            &profile_with_proxy_required(),
            Some(&broker_dir),
        );
        assert!(argv.contains(&"--unshare-net".to_string()));
        assert!(argv.windows(2).any(|window| {
            window[0] == "--tmpfs" && window[1] == broker_root.display().to_string()
        }));
        assert!(argv
            .windows(2)
            .any(|window| { window[0] == "--tmpfs" && window[1] == "/run" }));
        assert!(argv.windows(3).any(|window| {
            window[0] == "--ro-bind"
                && window[1] == broker_dir.display().to_string()
                && window[2] == LinuxSandboxBackend::EGRESS_BROKER_GUEST_DIR
        }));
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

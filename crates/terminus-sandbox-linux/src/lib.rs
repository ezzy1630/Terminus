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
//! - When `bwrap` IS on `$PATH`, a real namespace probe succeeds, cgroup v2
//!   is delegated, AND a minimal-root mount plan can be built, the backend
//!   reports `Enforced` for exactly those features. Filesystem, git-protection,
//!   and secret-isolation claims are DERIVED from the generated mount plan
//!   ([`mounts::plan_proven_features`]) so the report cannot drift from the
//!   argv.
//! - The sandbox root is an empty directory plus explicitly mounted runtime
//!   trees — never `--ro-bind / /`. Host home directories, credentials,
//!   `.git`/`.terminus` state, and control sockets are invisible unless a
//!   profile rule mounts them; Deny rules become tmpfs overlays that shadow
//!   any parent bind.
//! - When `bwrap` is NOT on `$PATH`, the backend reports `Degraded` with an
//!   explicit note naming the missing binary. Profiles that require
//!   namespace isolation (e.g. `network: Deny`) are rejected with
//!   `SandboxError::Unsupported`.
//!
//! This module does not link `bubblewrap` directly; it invokes the binary
//! on PATH through `std::process::Command` at construction time to verify
//! availability, and constructs the bwrap argv from the mount plan when
//! `spawn_in_sandbox` is called.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]
#![forbid(unsafe_code)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use terminus_kernel_protocol::CommandSpec;
use terminus_sandbox::profile::{NetworkAccess, SandboxProfile};
use terminus_sandbox::report::{EnforcementFeature, EnforcementReport, EnforcementStatus};
use terminus_sandbox::{SandboxBackend, SandboxError};

mod enforcement;
pub mod mounts;

// The packaged kernel binary relaunches itself through these Linux-only
// enforcement entrypoints. Keep the implementation private while exposing
// the narrow binary boundary required by `mini-services/terminus-kernel`.
pub use enforcement::{run_launcher, run_payload, run_probe, LAUNCHER_ARG, PAYLOAD_ARG};
pub use mounts::{plan_mounts, plan_proven_features, HostLayout, MountPlan};

/// Process-wide empty directory used as the minimal sandbox root. It
/// contains nothing; every visible path must be mounted explicitly.
static EMPTY_ROOT: OnceLock<PathBuf> = OnceLock::new();

fn shared_empty_root() -> Option<&'static Path> {
    if let Some(path) = EMPTY_ROOT.get() {
        return Some(path.as_path());
    }
    let dir = std::env::temp_dir().join(format!(
        "terminus-sandbox-empty-root-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).ok()?;
    let path = EMPTY_ROOT.get_or_init(|| dir);
    Some(path.as_path())
}

/// Reference materialization used for backend-wide feature claims. The
/// enforcement report describes backend capability, so it plans against a
/// real temporary workspace laid out like the kernel emits after
/// `materialize_workspace_profile`: exact worktree bind plus `.git`,
/// `.terminus`, and credentials Deny overlays. Claims stay derived from the
/// resulting [`MountPlan`] rather than asserted.
fn reference_plan(layout: &HostLayout) -> Option<MountPlan> {
    static REF: OnceLock<PathBuf> = OnceLock::new();
    let ws = REF.get_or_init(|| {
        let dir =
            std::env::temp_dir().join(format!("terminus-sandbox-ref-ws-{}", std::process::id()));
        let _ = std::fs::create_dir_all(dir.join(".git"));
        let _ = std::fs::create_dir_all(dir.join(".terminus"));
        let _ = std::fs::create_dir_all(dir.join("credentials"));
        dir
    });
    use terminus_sandbox::profile::{FilesystemRule, SecretsAccess};
    let profile = SandboxProfile {
        id: "reference-restrictive".to_string(),
        filesystem: vec![
            FilesystemRule {
                path: ws.display().to_string(),
                access: terminus_sandbox::profile::FilesystemAccess::ReadWrite,
            },
            FilesystemRule {
                path: ws.join(".git").display().to_string(),
                access: terminus_sandbox::profile::FilesystemAccess::Deny,
            },
            FilesystemRule {
                path: ws.join(".terminus").display().to_string(),
                access: terminus_sandbox::profile::FilesystemAccess::Deny,
            },
            FilesystemRule {
                path: ws.join("credentials").display().to_string(),
                access: terminus_sandbox::profile::FilesystemAccess::Deny,
            },
        ],
        network: NetworkAccess::Deny,
        process: terminus_sandbox::profile::ProcessAccess::AllowWithLimits,
        secrets: SecretsAccess::BrokeredCapabilities,
        resources: terminus_sandbox::ResourceLimits::default(),
        plugins_ambient_authority: false,
    };
    let _ = std::fs::create_dir_all(ws);
    Some(plan_mounts(&profile, layout, shared_empty_root(), None))
}

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
    /// (reports `Enforced` for namespace features once verified). If `false`,
    /// the backend behaves as if `bwrap` was NOT found (reports `Degraded`).
    /// This bypasses the filesystem existence check — useful for unit tests.
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

    /// Build the `bwrap` argv for `command` under `profile`. Probes the host
    /// layout and uses the shared minimal root. See
    /// [`Self::build_bwrap_argv_with_layout`] for the pure variant.
    ///
    /// The argv encodes:
    /// - `--unshare-all` — user, pid, mount, ipc, uts namespaces.
    /// - `--unshare-net` (only when `profile.network == Deny|ProxyRequired`).
    /// - A MINIMAL ROOT built from an empty directory plus explicit runtime
    ///   tree binds (`/usr`, `/sys`, merged-/usr symlinks) — the host root
    ///   itself is never exposed.
    /// - Exact workspace binds from materialized filesystem rules, with
    ///   Deny-rule tmpfs overlays emitted after parent binds.
    /// - `--clearenv` plus synthetic `HOME`/`TMPDIR`/`PATH` and the caller's
    ///   public env.
    /// - `--proc /proc`, `--dev /dev` — mount /proc and /dev.
    /// - `--die-with-parent`, `--new-session`, `--cap-drop ALL`.
    /// - `--chdir <cwd>` then `-- <program> <args...>`.
    pub fn build_bwrap_argv(command: &CommandSpec, profile: &SandboxProfile) -> Vec<String> {
        let layout = HostLayout::probe();
        Self::build_bwrap_argv_with_layout(command, profile, &layout)
    }

    /// Pure variant taking an explicit layout snapshot. The minimal root is
    /// included when it is available (it always is on a functioning tmpfs).
    pub fn build_bwrap_argv_with_layout(
        command: &CommandSpec,
        profile: &SandboxProfile,
        layout: &HostLayout,
    ) -> Vec<String> {
        Self::build_bwrap_argv_full(command, profile, layout, shared_empty_root(), None)
    }

    /// Fully parameterized argv builder. `empty_root=None` produces a plan
    /// without the minimal root (the enforcement report will then refuse to
    /// claim FilesystemIsolation); production callers always supply it via
    /// the shared root or an explicit path.
    pub fn build_bwrap_argv_full(
        command: &CommandSpec,
        profile: &SandboxProfile,
        layout: &HostLayout,
        empty_root: Option<&Path>,
        broker_dir: Option<&Path>,
    ) -> Vec<String> {
        let plan = plan_mounts(profile, layout, empty_root, broker_dir);
        let mut argv: Vec<String> = Vec::new();

        // Namespace isolation. --unshare-all covers user, pid, mount, ipc, uts.
        argv.push("--unshare-all".to_string());
        if matches!(
            profile.network,
            NetworkAccess::Deny | NetworkAccess::ProxyRequired
        ) {
            argv.push("--unshare-net".to_string());
        }

        // Environment contract first: clear ambient env before any --setenv
        // applies, so no host variable survives into the payload.
        mounts::push_env_argv(&mut argv, &command.public_env);

        // Mount plan: minimal root, runtime trees, exact workspace binds,
        // deny overlays, optional broker lease.
        for op in &plan.mounts {
            op.push_argv(&mut argv);
        }

        // Pseudo-filesystems so basic tools work.
        argv.push("--proc".to_string());
        argv.push("/proc".to_string());
        argv.push("--dev".to_string());
        argv.push("/dev".to_string());

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
        let layout = HostLayout::probe();
        let argv =
            Self::build_bwrap_argv_full(command, profile, &layout, shared_empty_root(), broker_dir);
        enforcement::payload_wrapper(bwrap_path, &argv, profile.resources, profile.network)
    }

    /// Spawn `command` inside a bwrap sandbox configured by `profile`.
    /// Returns the captured `std::process::Output` (stdout, stderr, exit
    /// code). Returns `SandboxError::Unsupported` if `bwrap` was not
    /// available at construction time or the minimal root is unavailable.
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
        if shared_empty_root().is_none() {
            return Err(SandboxError::Unsupported(
                "minimal sandbox root unavailable; refusing to expose host root".to_string(),
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
        // The bwrap argv carries --clearenv plus explicit --setenv entries;
        // clearing here additionally keeps the trusted launcher's own env
        // out of bubblewrap's process environment.
        cmd.env_clear();
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
    /// caller fails closed; the enforcement report already says Degraded).
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

    /// Derive the report from what this construction actually produced:
    /// the mount plan proves filesystem/git/secret features; verified
    /// namespaces + delegated cgroup prove the rest.
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
            let layout = HostLayout::probe();
            let mut enforced = reference_plan(&layout)
                .map(|plan| plan_proven_features(&plan))
                .unwrap_or_default();
            enforced.extend([
                EnforcementFeature::NetworkIsolation,
                EnforcementFeature::NetworkNamespace,
                EnforcementFeature::ProxyOnlyEgress,
                EnforcementFeature::ProcessIsolation,
                EnforcementFeature::ProcessTreeContainment,
                EnforcementFeature::NoNewPrivs,
                EnforcementFeature::PluginAmbientAuthorityDenial,
                EnforcementFeature::PidNamespace,
                EnforcementFeature::MountNamespace,
                EnforcementFeature::UserNamespace,
                EnforcementFeature::SeccompFilter,
                EnforcementFeature::CgroupResourceLimits,
            ]);
            return EnforcementReport {
                backend_id: self.id().to_string(),
                status: EnforcementStatus::Enforced,
                enforced,
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
                    "minimal-root mount plan: host root never bound; runtime trees read-only; \
                     workspace exact-bound; deny rules shadowed by tmpfs overlays"
                        .to_string(),
                    "protected .git/.terminus/credentials via tmpfs overlays over the \
                     workspace bind"
                        .to_string(),
                    "process tree containment via PID namespace + --die-with-parent".to_string(),
                    "secret isolation via --clearenv + synthetic HOME + brokered capabilities "
                        .to_string(),
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
                EnforcementFeature::ProtectedGit,
                EnforcementFeature::SecretIsolation,
                EnforcementFeature::SeccompFilter,
                EnforcementFeature::NoNewPrivs,
                EnforcementFeature::PidNamespace,
                EnforcementFeature::MountNamespace,
                EnforcementFeature::UserNamespace,
            ],
            notes: vec![
                "degraded: bubblewrap (bwrap) not found or not verified on PATH; namespace isolation unavailable"
                    .to_string(),
                "degraded builds never construct a mount plan: no minimal root, no workspace bind, no overlay protection"
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
        // Without a minimal root there is no honest way to enforce
        // filesystem policy in the namespace at all: fail closed.
        if shared_empty_root().is_none() {
            return Err(SandboxError::Unsupported(
                "minimal sandbox root unavailable; refusing to build a host-visible namespace"
                    .into(),
            ));
        }
        // Profiles that require network isolation may only be selected after
        // the complete enforcement chain is verified. Merely finding a
        // `bwrap` binary is insufficient: a failed namespace probe or an
        // unavailable delegated cgroup would otherwise let a caller select
        // this backend while `spawn_wrapper()` returns `None`. Secure callers
        // must receive a typed refusal before any direct spawn is possible.
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
/// `Err(SandboxError::Unsupported)` so callers can record the gap honestly.
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

/// Functional probe used before trusting a resolved `bwrap` path. Mirrors
/// the shipped argv shape (minimal root, no host-root bind) so the probe
/// exercises what production will run. Tries a merged-/usr layout first,
/// then a classic layout.
fn probe_bwrap_path(path: &std::path::Path) -> bool {
    let base = [
        "--unshare-all".to_string(),
        "--proc".to_string(),
        "/proc".to_string(),
        "--dev".to_string(),
        "/dev".to_string(),
        "--die-with-parent".to_string(),
        "--new-session".to_string(),
        "--cap-drop".to_string(),
        "ALL".to_string(),
    ];
    let merged = [
        "--ro-bind".to_string(),
        "/usr".to_string(),
        "/usr".to_string(),
        "--symlink".to_string(),
        "usr/bin".to_string(),
        "/bin".to_string(),
    ];
    let classic = ["/bin", "/sbin", "/lib", "/lib64"]
        .iter()
        .flat_map(|dir| ["--ro-bind".to_string(), dir.to_string(), dir.to_string()])
        .collect::<Vec<_>>();
    let tail = [
        "--clearenv".to_string(),
        "--setenv".to_string(),
        "PATH".to_string(),
        "/usr/bin:/bin:/sbin".to_string(),
        "--".to_string(),
        "/bin/true".to_string(),
    ];
    let mut attempt = Vec::with_capacity(base.len() + merged.len() + tail.len());
    attempt.extend_from_slice(&base);
    attempt.extend_from_slice(&merged);
    attempt.extend_from_slice(&tail);
    let ok = Command::new(path)
        .args(&attempt)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    if ok {
        return true;
    }
    let mut fallback = Vec::with_capacity(base.len() + classic.len() + tail.len());
    fallback.extend_from_slice(&base);
    fallback.extend(classic);
    fallback.extend_from_slice(&tail);
    Command::new(path)
        .args(&fallback)
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
        assert!(!report
            .enforced
            .contains(&EnforcementFeature::SecretIsolation));
        assert!(!report.enforced.contains(&EnforcementFeature::ProtectedGit));
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
    fn build_bwrap_argv_never_binds_host_root() {
        // Release blocker 0: the historical `--ro-bind / /` exposed the whole
        // host. No argv may bind "/" as either source or destination except
        // the minimal-empty-root bind (source = empty dir, dest = "/").
        let cmd = simple_command("ls");
        let profile = restrictive_profile();
        let argv = LinuxSandboxBackend::build_bwrap_argv(&cmd, &profile);
        let mut i = 0;
        while i < argv.len() {
            if argv[i] == "--ro-bind" || argv[i] == "--bind" {
                let src = &argv[i + 1];
                let dst = &argv[i + 2];
                assert_ne!(src, "/", "host root bound as source: {argv:?}");
                if dst == "/" {
                    // Only permitted for the empty minimal root.
                    assert_ne!(src, "/");
                    assert!(src.starts_with(std::env::temp_dir().to_str().unwrap_or("/tmp")));
                }
                i += 3;
            } else {
                i += 1;
            }
        }
    }

    #[test]
    fn build_bwrap_argv_builds_minimal_root_and_runtime_trees() {
        let cmd = simple_command("ls");
        let argv = LinuxSandboxBackend::build_bwrap_argv(&cmd, &restrictive_profile());
        // Empty root bind present.
        let has_root_bind = argv.windows(3).any(|w| w[0] == "--ro-bind" && w[2] == "/");
        assert!(has_root_bind, "minimal empty root missing: {argv:?}");
        // /usr read-only.
        assert!(argv
            .windows(3)
            .any(|w| w[0] == "--ro-bind" && w[1] == "/usr" && w[2] == "/usr"));
        // proc/dev/tmpfs scratch.
        assert!(argv.contains(&"--proc".to_string()));
        assert!(argv.contains(&"/proc".to_string()));
        assert!(argv.contains(&"--dev".to_string()));
        assert!(argv.contains(&"/dev".to_string()));
        assert!(argv.windows(2).any(|w| w[0] == "--tmpfs" && w[1] == "/tmp"));
    }

    #[test]
    fn build_bwrap_argv_clears_env_and_sets_synthetic_home() {
        let cmd = CommandSpec {
            program: "env".to_string(),
            args: vec![],
            cwd: WorkspacePath::new("ws-1", "."),
            public_env: [("ONLYVAR".to_string(), "1".to_string())]
                .into_iter()
                .collect(),
            ..Default::default()
        };
        let argv = LinuxSandboxBackend::build_bwrap_argv(&cmd, &restrictive_profile());
        let clearenv = argv
            .iter()
            .position(|a| a == "--clearenv")
            .expect("clearenv");
        let home_idx = argv.iter().position(|a| a == "HOME").expect("HOME setenv");
        assert!(
            clearenv < home_idx,
            "clearenv must precede setenv: {argv:?}"
        );
        let home_val = argv[home_idx + 1].clone();
        assert_eq!(home_val, mounts::SYNTHETIC_HOME);
        // public env applied after defaults.
        let only = argv
            .iter()
            .position(|a| a == "ONLYVAR")
            .expect("public env");
        assert!(only > home_idx);
        assert_eq!(argv.get(only + 1), Some(&"1".to_string()));
        // The outer command no longer relies on inherited environment.
        let path_idx = argv.iter().position(|a| a == "PATH").expect("PATH setenv");
        assert_eq!(
            argv.get(path_idx + 1),
            Some(&mounts::DEFAULT_PATH.to_string())
        );
    }

    #[test]
    fn build_bwrap_argv_shadows_deny_rules_after_parent_bind() {
        // Materialized profile like the kernel emits: absolute paths.
        let ws = "/tmp/ws-under-test";
        let profile = SandboxProfile {
            id: "materialized".to_string(),
            filesystem: vec![
                FilesystemRule {
                    path: ws.to_string(),
                    access: FilesystemAccess::ReadWrite,
                },
                FilesystemRule {
                    path: format!("{ws}/.git"),
                    access: FilesystemAccess::Deny,
                },
                FilesystemRule {
                    path: format!("{ws}/.terminus"),
                    access: FilesystemAccess::Deny,
                },
            ],
            network: NetworkAccess::Allow,
            process: ProcessAccess::AllowWithLimits,
            secrets: SecretsAccess::BrokeredCapabilities,
            resources: ResourceLimits::default(),
            plugins_ambient_authority: false,
        };
        let cmd = simple_command("ls");
        let argv = LinuxSandboxBackend::build_bwrap_argv_with_layout(
            &cmd,
            &profile,
            &HostLayout::merged_usr_reference(),
        );
        let bind_idx = argv
            .windows(3)
            .position(|w| w[0] == "--bind" && w[1] == ws && w[2] == ws)
            .expect("workspace rw bind");
        let git_overlay = argv
            .windows(2)
            .position(|w| w[0] == "--tmpfs" && w[1] == format!("{ws}/.git"))
            .expect(".git tmpfs overlay");
        let terminus_overlay = argv
            .windows(2)
            .position(|w| w[0] == "--tmpfs" && w[1] == format!("{ws}/.terminus"))
            .expect(".terminus tmpfs overlay");
        assert!(
            bind_idx < git_overlay && bind_idx < terminus_overlay,
            "deny overlays must follow the parent bind: {argv:?}"
        );
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
    fn build_bwrap_argv_appends_command_after_double_dash() {
        let cmd = CommandSpec {
            program: "echo".to_string(),
            args: vec!["hello".to_string(), "world".to_string()],
            cwd: WorkspacePath::new("ws-1", "."),
            ..Default::default()
        };
        let profile = restrictive_profile();
        let argv = LinuxSandboxBackend::build_bwrap_argv(&cmd, &profile);
        let dash_idx = argv.iter().rev().position(|a| a == "--").unwrap();
        let dash_idx = argv.len() - 1 - dash_idx;
        // After --, we expect: echo hello world
        assert_eq!(argv.get(dash_idx + 1), Some(&"echo".to_string()));
        assert_eq!(argv.get(dash_idx + 2), Some(&"hello".to_string()));
        assert_eq!(argv.get(dash_idx + 3), Some(&"world".to_string()));
        // Nothing after the last arg.
        assert_eq!(argv.len(), dash_idx + 4);
    }

    #[test]
    fn build_bwrap_argv_skips_workspace_uri_rules() {
        // Unmaterialized logical rules MUST NOT appear as --bind targets.
        let cmd = simple_command("ls");
        let profile = restrictive_profile();
        let argv = LinuxSandboxBackend::build_bwrap_argv(&cmd, &profile);
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
        let argv = LinuxSandboxBackend::build_bwrap_argv_full(
            &command,
            &profile_with_proxy_required(),
            &HostLayout::merged_usr_reference(),
            shared_empty_root(),
            Some(&broker_dir),
        );
        assert!(argv.contains(&"--unshare-net".to_string()));
        assert!(argv.windows(3).any(|window| {
            window[0] == "--ro-bind"
                && window[1] == broker_dir.display().to_string()
                && window[2] == LinuxSandboxBackend::EGRESS_BROKER_GUEST_DIR
        }));
        // The host lease parent must NOT be mounted anywhere.
        assert!(!argv
            .windows(3)
            .any(|w| (w[0] == "--ro-bind" || w[0] == "--bind")
                && w[1] == broker_root.display().to_string()));
        // /run stays a fresh tmpfs so other leases are invisible.
        assert!(argv.windows(2).any(|w| w[0] == "--tmpfs" && w[1] == "/run"));
    }

    fn profile_with_proxy_required() -> SandboxProfile {
        let mut p = restrictive_profile();
        p.network = NetworkAccess::ProxyRequired;
        p
    }

    #[test]
    fn readonly_rule_is_bound_read_only() {
        let profile = SandboxProfile {
            id: "test-abs-ro".to_string(),
            filesystem: vec![FilesystemRule {
                path: "/etc/pki".to_string(),
                access: FilesystemAccess::ReadOnly,
            }],
            network: NetworkAccess::Allow,
            process: ProcessAccess::AllowWithLimits,
            secrets: SecretsAccess::BrokeredCapabilities,
            resources: ResourceLimits::default(),
            plugins_ambient_authority: false,
        };
        let cmd = simple_command("ls");
        let argv = LinuxSandboxBackend::build_bwrap_argv_with_layout(
            &cmd,
            &profile,
            &HostLayout::merged_usr_reference(),
        );
        assert!(argv
            .windows(3)
            .any(|w| w[0] == "--ro-bind" && w[1] == "/etc/pki" && w[2] == "/etc/pki"));
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

    // ---------- mount-plan feature derivation ----------

    #[test]
    fn plan_features_track_the_actual_plan() {
        use terminus_sandbox::report::EnforcementFeature;
        let layout = HostLayout::merged_usr_reference();
        let plan = plan_mounts(
            &SandboxProfile::default_restrictive(),
            &layout,
            shared_empty_root(),
            None,
        );
        let features = plan_proven_features(&plan);
        // The default restrictive profile materializes to a workspace RW bind
        // only when the kernel provides one; with logical rules unbound the
        // plan has no workspace bind, so FilesystemIsolation must NOT be
        // claimed from this static call site.
        if plan.workspace_rw_binds.is_empty() {
            assert!(!features.contains(&EnforcementFeature::FilesystemIsolation));
        } else {
            assert!(features.contains(&EnforcementFeature::FilesystemIsolation));
        }
        assert!(features.contains(&EnforcementFeature::SecretIsolation));
        assert!(features.contains(&EnforcementFeature::AmbientSecretDenial));

        // Without a minimal root nothing may be proven about filesystems.
        let open_plan = plan_mounts(&SandboxProfile::default_restrictive(), &layout, None, None);
        assert!(!open_plan.minimal_root);
        assert!(
            !plan_proven_features(&open_plan).contains(&EnforcementFeature::FilesystemIsolation)
        );
    }
}

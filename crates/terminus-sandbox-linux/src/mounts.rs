//! Minimal-root mount planning for the Linux Bubblewrap backend
//! (SPEC §36.5; deep-audit release blocker 0).
//!
//! The historical argv used `--ro-bind / /`, which exposed the entire host
//! filesystem (read-only) inside the sandbox: home directories, SSH/cloud
//! credentials, repository internals, and control sockets were all reachable
//! by absolute path even though brokered kernel calls stayed restricted. A
//! spawned program opens files itself, so PathResolver policy cannot protect
//! them — the *mount plan* must.
//!
//! This module derives the complete bwrap mount/env argv from:
//!
//! - a [`HostLayout`] snapshot (which runtime trees exist on the host);
//! - the materialized [`SandboxProfile`] (workspace rules already converted
//!   to absolute host paths by the kernel);
//! - an optional private egress-broker directory.
//!
//! The result is a minimal root built from an empty directory plus exactly
//! the runtime trees required to execute programs, one exact workspace bind,
//! tmpfs overlays over every Deny rule (so nested paths such as `.git` are
//! shadowed), a synthetic HOME, and a cleared environment. Enforcement
//! features are derived from the plan itself so the report cannot drift
//! from the generated argv.

use std::path::Path;
use terminus_sandbox::profile::{FilesystemAccess, SandboxProfile};

/// One resolved entry in the mount plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MountOp {
    /// Read-only bind of an exact host path.
    RoBind(String, String),
    /// Read-write bind of an exact host path.
    Bind(String, String),
    /// Fresh empty tmpfs at the guest path (used to shadow Deny rules and
    /// to synthesize scratch/home/run trees).
    Tmpfs(String),
    /// Guest symlink (used for merged-/usr layouts).
    Symlink(String, String),
    /// Empty host directory bound read-only at `/` — the minimal root.
    EmptyRoot(String),
}

impl MountOp {
    /// Append the bwrap argv fragment for this operation.
    pub fn push_argv(&self, argv: &mut Vec<String>) {
        match self {
            MountOp::RoBind(src, dst) => {
                argv.push("--ro-bind".into());
                argv.push(src.clone());
                argv.push(dst.clone());
            }
            MountOp::Bind(src, dst) => {
                argv.push("--bind".into());
                argv.push(src.clone());
                argv.push(dst.clone());
            }
            MountOp::Tmpfs(path) => {
                argv.push("--tmpfs".into());
                argv.push(path.clone());
            }
            MountOp::Symlink(target, link) => {
                argv.push("--symlink".into());
                argv.push(target.clone());
                argv.push(link.clone());
            }
            MountOp::EmptyRoot(dir) => {
                argv.push("--ro-bind".into());
                argv.push(dir.clone());
                argv.push("/".to_string());
            }
        }
    }
}

/// Which runtime trees exist on this host. Probed once per backend; unit
/// tests construct explicit values.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostLayout {
    pub usr_exists: bool,
    pub usr_local_exists: bool,
    pub nix_exists: bool,
    /// Real (non-symlink) `/sys` directory — bound read-only so cgroup
    /// state stays visible without exposing writable sysfs.
    pub sys_real_dir: bool,
    /// Real (non-symlink) `/lib` directory.
    pub lib_real_dir: bool,
    /// Real (non-symlink) `/lib64` directory.
    pub lib64_real_dir: bool,
    /// `/lib` is a symlink into usr (merged-/usr layout).
    pub lib_is_symlink: bool,
    /// `/lib64` is a symlink into usr (merged-/usr layout).
    pub lib64_is_symlink: bool,
    /// `/usr/lib` exists (symlink target for merged /lib).
    pub usr_lib_exists: bool,
    /// `/usr/lib64` exists (symlink target for merged /lib64).
    pub usr_lib64_exists: bool,
    /// `/bin` is a real directory (classic layout).
    pub bin_real_dir: bool,
    /// `/sbin` is a real directory (classic layout).
    pub sbin_real_dir: bool,
    /// `/bin` is a symlink into usr (merged-/usr layout).
    pub bin_is_symlink: bool,
    /// `/sbin` is a symlink into usr (merged-/usr layout).
    pub sbin_is_symlink: bool,
}

impl HostLayout {
    /// Snapshot the host runtime layout. Missing paths simply produce a
    /// plan without them; the probe verifies executability afterwards.
    pub fn probe() -> Self {
        let dir_kind = |p: &str| {
            std::fs::symlink_metadata(p)
                .map(|m| m.is_dir())
                .unwrap_or(false)
        };
        let is_symlink = |p: &str| {
            std::fs::symlink_metadata(p)
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(false)
        };
        Self {
            usr_exists: dir_kind("/usr"),
            usr_local_exists: dir_kind("/usr/local"),
            nix_exists: dir_kind("/nix"),
            sys_real_dir: dir_kind("/sys"),
            lib_real_dir: dir_kind("/lib"),
            lib64_real_dir: dir_kind("/lib64"),
            lib_is_symlink: is_symlink("/lib"),
            lib64_is_symlink: is_symlink("/lib64"),
            usr_lib_exists: dir_kind("/usr/lib"),
            usr_lib64_exists: dir_kind("/usr/lib64"),
            bin_real_dir: dir_kind("/bin"),
            sbin_real_dir: dir_kind("/sbin"),
            bin_is_symlink: is_symlink("/bin"),
            sbin_is_symlink: is_symlink("/sbin"),
        }
    }

    /// A layout representing a typical merged-/usr Linux host. Used by
    /// tests and by callers that cannot probe (e.g. cross-compilation).
    pub fn merged_usr_reference() -> Self {
        Self {
            usr_exists: true,
            usr_local_exists: true,
            nix_exists: false,
            sys_real_dir: true,
            lib_real_dir: false,
            lib64_real_dir: false,
            lib_is_symlink: true,
            lib64_is_symlink: true,
            usr_lib_exists: true,
            usr_lib64_exists: false,
            bin_real_dir: false,
            sbin_real_dir: false,
            bin_is_symlink: true,
            sbin_is_symlink: true,
        }
    }
}

/// Synthetic guest HOME. Never a host path; mounted as tmpfs.
pub const SYNTHETIC_HOME: &str = "/home/terminus-sandbox";
pub const DEFAULT_PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/// The complete planned sandbox filesystem/environment shape.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MountPlan {
    pub mounts: Vec<MountOp>,
    pub workspace_rw_binds: Vec<(String, String)>,
    pub workspace_ro_binds: Vec<(String, String)>,
    pub deny_overlays: Vec<String>,
    /// True when the plan builds from an empty/minimal root instead of
    /// binding the host root.
    pub minimal_root: bool,
    /// True when the environment is cleared and only explicit vars set.
    pub clears_environment: bool,
    pub synthetic_home: Option<String>,
}

/// Build the mount plan for `profile` under `layout`.
///
/// Ordering matters: bubblewrap applies mounts in argv order and later
/// mounts shadow earlier ones, so Deny-rule tmpfs overlays are emitted
/// after their parent workspace binds.
pub fn plan_mounts(
    profile: &SandboxProfile,
    layout: &HostLayout,
    empty_root: Option<&Path>,
    broker_dir: Option<&Path>,
) -> MountPlan {
    let mut plan = MountPlan {
        minimal_root: empty_root.is_some(),
        clears_environment: true,
        synthetic_home: Some(SYNTHETIC_HOME.to_string()),
        ..Default::default()
    };

    // Minimal root: an empty read-only directory at `/`. When unavailable
    // the caller must fail closed (the backend refuses to claim
    // FilesystemIsolation without it).
    if let Some(root) = empty_root {
        plan.mounts
            .push(MountOp::EmptyRoot(root.display().to_string()));
    }

    // Runtime trees, read-only. Nothing else from the host is visible.
    if layout.usr_exists {
        plan.mounts
            .push(MountOp::RoBind("/usr".into(), "/usr".into()));
    }
    if layout.usr_local_exists {
        plan.mounts
            .push(MountOp::RoBind("/usr/local".into(), "/usr/local".into()));
    }
    // Merged-/usr compatibility symlinks come before direct binds so a
    // host with real /lib dirs gets binds instead.
    if layout.bin_is_symlink {
        plan.mounts
            .push(MountOp::Symlink("usr/bin".into(), "/bin".into()));
    }
    if layout.sbin_is_symlink {
        plan.mounts
            .push(MountOp::Symlink("usr/sbin".into(), "/sbin".into()));
    }
    if layout.lib_real_dir {
        plan.mounts
            .push(MountOp::RoBind("/lib".into(), "/lib".into()));
    } else if layout.lib_is_symlink {
        // Merged-/usr: the guest needs its own compatibility symlink; the
        // target tree arrives via the /usr bind.
        plan.mounts
            .push(MountOp::Symlink("usr/lib".into(), "/lib".into()));
    }
    if layout.lib_real_dir {
        plan.mounts
            .push(MountOp::RoBind("/lib".into(), "/lib".into()));
    } else if layout.lib_is_symlink {
        // Merged-/usr: guest compatibility symlink; only emitted when the
        // resolved target exists so the guest never holds a dangling /lib.
        if layout.usr_lib_exists {
            plan.mounts
                .push(MountOp::Symlink("usr/lib".into(), "/lib".into()));
        }
    }
    if layout.lib64_real_dir {
        plan.mounts
            .push(MountOp::RoBind("/lib64".into(), "/lib64".into()));
    } else if layout.lib64_is_symlink && layout.usr_lib64_exists {
        plan.mounts
            .push(MountOp::Symlink("usr/lib64".into(), "/lib64".into()));
    }
    if layout.nix_exists {
        plan.mounts
            .push(MountOp::RoBind("/nix".into(), "/nix".into()));
    }

    if layout.sys_real_dir {
        plan.mounts
            .push(MountOp::RoBind("/sys".into(), "/sys".into()));
    }

    // Pseudo-filesystems and scratch space.
    plan.mounts.push(MountOp::Tmpfs("/tmp".into()));
    plan.mounts.push(MountOp::Tmpfs("/run".into()));
    plan.mounts.push(MountOp::Tmpfs(SYNTHETIC_HOME.to_string()));

    // Filesystem policy rules. Logical `workspace://` URIs never appear
    // here (the kernel materializes them); anything remaining must be an
    // absolute host path or it is ignored. The host root itself ("/") is
    // NEVER bound — that legacy rule means "no ambient root".
    //
    // Rules are applied least-specific-first so a nested read-only or Deny
    // rule shadows the writable parent it narrows (bubblewrap applies
    // mounts in argv order and later mounts win).
    let mut rules: Vec<&terminus_sandbox::profile::FilesystemRule> = profile
        .filesystem
        .iter()
        .filter(|rule| rule.path.starts_with('/') && rule.path != "/")
        .collect();
    rules.sort_by_key(|rule| Path::new(&rule.path).components().count());
    for rule in rules {
        match rule.access {
            FilesystemAccess::ReadOnly => {
                // bwrap ABORTS when a bind source does not exist. A rule for
                // a path the workspace happens not to have (`.git/config` in
                // a non-git checkout) must therefore be dropped, not
                // planned — this is the defect the phantom `active-worktree`
                // rule used to trigger on every single exec.
                if !Path::new(&rule.path).exists() {
                    continue;
                }
                plan.mounts
                    .push(MountOp::RoBind(rule.path.clone(), rule.path.clone()));
                plan.workspace_ro_binds
                    .push((rule.path.clone(), rule.path.clone()));
            }
            FilesystemAccess::ReadWrite => {
                if !Path::new(&rule.path).exists() {
                    continue;
                }
                plan.mounts
                    .push(MountOp::Bind(rule.path.clone(), rule.path.clone()));
                plan.workspace_rw_binds
                    .push((rule.path.clone(), rule.path.clone()));
            }
            FilesystemAccess::Deny => {
                // Shadowed AFTER every bind below so a Deny path nested
                // inside a bound parent (workspace/.terminus) is hidden even
                // though the parent is mounted. Emitted unconditionally: a
                // tmpfs needs no source, and bwrap creates the mountpoint.
                plan.deny_overlays.push(rule.path.clone());
            }
        }
    }

    // Deny overlays last: they shadow any exposure inherited through a
    // parent bind mount.
    for deny in &plan.deny_overlays {
        plan.mounts.push(MountOp::Tmpfs(deny.clone()));
    }

    // Private egress-broker lease: expose exactly one directory (with a
    // single 0600 socket) at a fixed guest path. /run is a fresh tmpfs, so
    // the host lease parent is not visible regardless.
    if let Some(broker) = broker_dir {
        plan.mounts.push(MountOp::RoBind(
            broker.display().to_string(),
            super::LinuxSandboxBackend::EGRESS_BROKER_GUEST_DIR.to_string(),
        ));
    }

    plan
}

/// Extend the plan-derived argv with the environment contract:
/// cleared environment, synthetic HOME/TMPDIR, default PATH, then the
/// caller's public env (which may override the defaults explicitly).
pub fn push_env_argv(
    argv: &mut Vec<String>,
    public_env: &std::collections::BTreeMap<String, String>,
) {
    argv.push("--clearenv".to_string());
    argv.push("--setenv".to_string());
    argv.push("HOME".to_string());
    argv.push(SYNTHETIC_HOME.to_string());
    argv.push("--setenv".to_string());
    argv.push("TMPDIR".to_string());
    argv.push("/tmp".to_string());
    argv.push("--setenv".to_string());
    argv.push("PATH".to_string());
    argv.push(DEFAULT_PATH.to_string());
    for (key, value) in public_env {
        argv.push("--setenv".to_string());
        argv.push(key.clone());
        argv.push(value.clone());
    }
}

/// Features PROVEN by the plan itself (independent of runtime probes).
/// Namespace/seccomp/cgroup claims still require the executable probe and
/// are layered on by the backend's enforcement_report.
pub fn plan_proven_features(plan: &MountPlan) -> Vec<terminus_sandbox::report::EnforcementFeature> {
    use terminus_sandbox::report::EnforcementFeature;
    let mut features = Vec::new();
    if plan.minimal_root && !plan.workspace_rw_binds.is_empty() {
        features.push(EnforcementFeature::FilesystemIsolation);
    }
    // Git protection is either "the whole `.git` is hidden" (a Deny overlay)
    // or "the execution-vector files inside `.git` are read-only" — the
    // shape the default profile ships, so `git status`/`git add` keep
    // working while `.git/hooks` and `.git/config` cannot be rewritten.
    let git_hidden = plan.deny_overlays.iter().any(|p| p.ends_with("/.git"));
    let git_write_protected = plan
        .workspace_ro_binds
        .iter()
        .any(|(source, _)| source.ends_with("/.git/config") || source.ends_with("/.git/hooks"));
    if plan.minimal_root && (git_hidden || git_write_protected) {
        features.push(EnforcementFeature::ProtectedGit);
    }
    if plan.clears_environment && plan.synthetic_home.is_some() {
        features.push(EnforcementFeature::SecretIsolation);
        features.push(EnforcementFeature::AmbientSecretDenial);
    }
    features
}

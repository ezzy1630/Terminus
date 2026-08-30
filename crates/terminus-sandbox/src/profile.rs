//! Sandbox profile (SPEC.md Section 13.3).

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilesystemAccess {
    /// Reads are allowed; writes are DENIED. Nested under a `ReadWrite`
    /// parent this is a write-protection overlay: the payload can still see
    /// the bytes (so `git status`/`git diff` work) but cannot change them.
    ReadOnly,
    /// Reads and writes are allowed.
    ReadWrite,
    /// Neither reads nor writes (nor metadata, where the backend can express
    /// it). Nested under a `ReadWrite` parent this hides the subtree.
    Deny,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FilesystemRule {
    pub path: String,
    pub access: FilesystemAccess,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NetworkAccess {
    Allow,
    Deny,
    ProxyRequired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessAccess {
    Allow,
    Deny,
    AllowWithLimits,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretsAccess {
    AmbientEnvironment,
    BrokeredCapabilities,
    Deny,
}

/// Wall clock applied when the caller supplies no `timeout_ms` at all.
pub const DEFAULT_WALL_CLOCK_MS: u64 = 60_000;
/// Hard ceiling for a FOREGROUND exec (`ProcessService::start_in_profile`).
pub const MAX_FOREGROUND_WALL_CLOCK_MS: u64 = 600_000;
/// Hard ceiling for a durable BACKGROUND job (`JobService::start`). This is
/// also the kernel's absolute ceiling: no exec may exceed it.
pub const MAX_BACKGROUND_WALL_CLOCK_MS: u64 = 1_800_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ResourceLimits {
    pub cpu_ms: Option<u64>,
    pub memory_bytes: Option<u64>,
    pub pids: Option<u32>,
    /// The wall clock used when the caller supplies none (`timeout_ms == 0`).
    /// This is a DEFAULT, not a cap — see `max_wall_clock_ms`.
    pub wall_clock_ms: Option<u64>,
    /// The hard ceiling a caller-supplied `timeout_ms` is clamped to.
    /// `None` means "no profile-level ceiling"; the call site still applies
    /// its own (foreground vs. background).
    #[serde(default)]
    pub max_wall_clock_ms: Option<u64>,
}

impl Default for ResourceLimits {
    fn default() -> Self {
        Self {
            cpu_ms: None,
            memory_bytes: None,
            pids: Some(256),
            wall_clock_ms: Some(DEFAULT_WALL_CLOCK_MS),
            max_wall_clock_ms: Some(MAX_BACKGROUND_WALL_CLOCK_MS),
        }
    }
}

/// Resolve the wall clock for one exec.
///
/// - `requested_ms == 0` means the caller sent nothing: use the profile
///   default (60 s), itself bounded by the ceiling.
/// - Any other value is HONOURED, bounded by the tightest of `ceiling_ms`
///   (foreground vs. background, chosen by the call site) and the profile's
///   own `max_wall_clock_ms`.
#[must_use]
pub fn resolve_exec_timeout_ms(requested_ms: u64, limits: &ResourceLimits, ceiling_ms: u64) -> u64 {
    let profile_ceiling = limits
        .max_wall_clock_ms
        .filter(|value| *value > 0)
        .unwrap_or(u64::MAX);
    let ceiling = if ceiling_ms == 0 {
        profile_ceiling
    } else {
        ceiling_ms.min(profile_ceiling)
    };
    let requested = if requested_ms == 0 {
        limits
            .wall_clock_ms
            .filter(|value| *value > 0)
            .unwrap_or(DEFAULT_WALL_CLOCK_MS)
    } else {
        requested_ms
    };
    requested.min(ceiling)
}

/// File-name prefix of the kernel-provisioned scratch directory.
///
/// `materialize_workspace_profile` creates one directory per workspace,
/// names it `terminus-scratch-<hash>`, and adds it to the profile as a
/// `ReadWrite` rule. Backends recognise it by this prefix and export it to
/// the payload as `TMPDIR`/`TMP`/`TEMP`. Keeping the marker in the rule set
/// (instead of a separate profile field) means every backend that already
/// honours filesystem rules grants access to it for free.
pub const SCRATCH_DIR_PREFIX: &str = "terminus-scratch-";

/// Workspace paths that stay READABLE but must never be writable.
///
/// These are the three paths that turn a repository checkout into an
/// execution vector: a hook, or a `core.pager` / `core.fsmonitor` /
/// `filter.*` / `alias.*` entry, runs on the NEXT git invocation — including
/// one the human types outside the sandbox.
pub const PROTECTED_GIT_OVERLAYS: &[&str] = &[
    "workspace://.git/hooks",
    "workspace://.git/config",
    "workspace://.git/config.worktree",
];

/// Workspace paths denied outright: kernel state and credential material.
pub const DENIED_WORKSPACE_OVERLAYS: &[&str] = &[
    "workspace://.terminus",
    "workspace://.terminus-dev",
    "workspace://.terminus-data",
    "workspace://credentials",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxProfile {
    pub id: String,
    pub filesystem: Vec<FilesystemRule>,
    pub network: NetworkAccess,
    pub process: ProcessAccess,
    pub secrets: SecretsAccess,
    pub resources: ResourceLimits,
    pub plugins_ambient_authority: bool,
}

/// The workspace root plus every protective overlay, in the order backends
/// expect (least specific first).
fn overlay_rules() -> Vec<FilesystemRule> {
    let mut rules = vec![FilesystemRule {
        path: "workspace://".to_string(),
        access: FilesystemAccess::ReadWrite,
    }];
    rules.extend(PROTECTED_GIT_OVERLAYS.iter().map(|path| FilesystemRule {
        path: (*path).to_string(),
        access: FilesystemAccess::ReadOnly,
    }));
    rules.extend(DENIED_WORKSPACE_OVERLAYS.iter().map(|path| FilesystemRule {
        path: (*path).to_string(),
        access: FilesystemAccess::Deny,
    }));
    rules
}

impl SandboxProfile {
    /// The default restrictive profile (SPEC.md Section 13.3).
    ///
    /// Filesystem shape (identical on every backend; see
    /// `terminus-sandbox-linux/src/lib.rs::reference_plan` for the bwrap
    /// materialization of the same rules):
    ///
    /// - the workspace root is the WRITABLE root — an agent that cannot
    ///   write its own checkout cannot do anything;
    /// - `.git` stays readable and mostly writable so `git status`,
    ///   `git diff`, `git add` and `git commit` all work: `.git/objects`,
    ///   `.git/index`, `.git/refs`, `.git/logs`, `.git/HEAD`, … inherit the
    ///   writable root;
    /// - `.git/hooks`, `.git/config` and `.git/config.worktree` are
    ///   write-protected but still readable. Those are the three paths that
    ///   turn a repository into an execution vector (a hook, or a
    ///   `core.pager`/`core.fsmonitor`/`filter.*`/`alias.*` entry, runs on
    ///   the NEXT git invocation — including one the human types outside the
    ///   sandbox);
    /// - `.terminus`, `.terminus-dev`, `.terminus-data` and `credentials`
    ///   are fully denied (no read, no write): kernel state and credential
    ///   material.
    ///
    /// There is deliberately no whole-filesystem `"/"` rule. macOS rendered
    /// it as `(allow file-read* (subpath "/"))`, which made `~/.ssh` and
    /// `~/.aws` readable from inside the sandbox; the macOS backend now
    /// emits an explicit system/toolchain read list instead.
    pub fn default_restrictive() -> Self {
        Self {
            id: "default-restrictive".to_string(),
            filesystem: overlay_rules(),
            network: NetworkAccess::Deny,
            process: ProcessAccess::AllowWithLimits,
            secrets: SecretsAccess::BrokeredCapabilities,
            resources: ResourceLimits::default(),
            plugins_ambient_authority: false,
        }
    }

    /// Re-assert every protective overlay on a profile, whatever else it
    /// carries. Idempotent: an overlay already present at the right access
    /// is left alone, a wrong access is corrected, a missing one is appended.
    ///
    /// Derived profiles go through this so they cannot silently lose the
    /// git and credential protections — `degraded-local` used to hand-match
    /// the path `workspace://.git`, and when the rule set changed shape that
    /// match became a no-op that nothing detected.
    pub fn enforce_workspace_overlays(&mut self) {
        let wanted = PROTECTED_GIT_OVERLAYS
            .iter()
            .map(|path| (*path, FilesystemAccess::ReadOnly))
            .chain(
                DENIED_WORKSPACE_OVERLAYS
                    .iter()
                    .map(|path| (*path, FilesystemAccess::Deny)),
            );
        for (path, access) in wanted {
            match self.filesystem.iter_mut().find(|rule| rule.path == path) {
                Some(rule) => rule.access = access,
                None => self.filesystem.push(FilesystemRule {
                    path: path.to_string(),
                    access,
                }),
            }
        }
    }

    /// Host path of the kernel-provisioned scratch directory, if this profile
    /// carries one. Backends export it as `TMPDIR`/`TMP`/`TEMP`.
    #[must_use]
    pub fn scratch_dir(&self) -> Option<&str> {
        self.filesystem
            .iter()
            .find(|rule| {
                matches!(rule.access, FilesystemAccess::ReadWrite)
                    && Path::new(&rule.path)
                        .file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.starts_with(SCRATCH_DIR_PREFIX))
            })
            .map(|rule| rule.path.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enforcing_overlays_restores_a_stripped_or_downgraded_profile() {
        let mut profile = SandboxProfile::default_restrictive();
        // Simulate both failure modes a derived profile can hit: an overlay
        // dropped entirely, and one downgraded to a weaker access.
        profile
            .filesystem
            .retain(|rule| rule.path != "workspace://.git/hooks");
        for rule in &mut profile.filesystem {
            if rule.path == "workspace://credentials" {
                rule.access = FilesystemAccess::ReadWrite;
            }
        }
        profile.enforce_workspace_overlays();
        for path in PROTECTED_GIT_OVERLAYS {
            let rule = profile.filesystem.iter().find(|r| r.path == *path);
            assert!(rule.is_some(), "{path} not restored");
            assert_eq!(
                rule.expect("presence asserted above").access,
                FilesystemAccess::ReadOnly
            );
        }
        for path in DENIED_WORKSPACE_OVERLAYS {
            let rule = profile.filesystem.iter().find(|r| r.path == *path);
            assert!(rule.is_some(), "{path} not restored");
            assert_eq!(
                rule.expect("presence asserted above").access,
                FilesystemAccess::Deny
            );
        }
        // Idempotent: a second pass changes nothing.
        let before = profile.filesystem.clone();
        profile.enforce_workspace_overlays();
        assert_eq!(before, profile.filesystem);
    }

    #[test]
    fn workspace_root_is_the_writable_root() {
        let profile = SandboxProfile::default_restrictive();
        let root = profile
            .filesystem
            .iter()
            .find(|rule| rule.path == "workspace://")
            .expect("workspace root rule");
        assert_eq!(root.access, FilesystemAccess::ReadWrite);
    }

    #[test]
    fn no_phantom_active_worktree_and_no_whole_filesystem_rule() {
        let profile = SandboxProfile::default_restrictive();
        assert!(
            !profile
                .filesystem
                .iter()
                .any(|rule| rule.path.contains("active-worktree")),
            "the `active-worktree` directory is never created by anything"
        );
        assert!(
            !profile.filesystem.iter().any(|rule| rule.path == "/"),
            "a whole-filesystem rule renders as `(subpath \"/\")` on macOS"
        );
    }

    #[test]
    fn git_object_database_is_writable_but_hooks_and_config_are_not() {
        let profile = SandboxProfile::default_restrictive();
        let access = |path: &str| {
            profile
                .filesystem
                .iter()
                .find(|rule| rule.path == path)
                .map(|rule| rule.access)
        };
        assert_eq!(
            access("workspace://.git/hooks"),
            Some(FilesystemAccess::ReadOnly)
        );
        assert_eq!(
            access("workspace://.git/config"),
            Some(FilesystemAccess::ReadOnly)
        );
        // No rule for the object database / index / refs: they inherit the
        // writable workspace root so `git add` and `git commit` work.
        assert_eq!(access("workspace://.git/objects"), None);
        assert_eq!(access("workspace://.git"), None);
    }

    #[test]
    fn kernel_state_and_credentials_are_fully_denied() {
        let profile = SandboxProfile::default_restrictive();
        for path in [
            "workspace://.terminus",
            "workspace://.terminus-dev",
            "workspace://.terminus-data",
            "workspace://credentials",
        ] {
            let rule = profile.filesystem.iter().find(|rule| rule.path == path);
            assert!(rule.is_some(), "missing deny rule for {path}");
            let rule = rule.expect("presence asserted above");
            assert_eq!(rule.access, FilesystemAccess::Deny, "{path}");
        }
    }

    #[test]
    fn absent_timeout_falls_back_to_the_sixty_second_default() {
        let limits = ResourceLimits::default();
        assert_eq!(
            resolve_exec_timeout_ms(0, &limits, MAX_FOREGROUND_WALL_CLOCK_MS),
            DEFAULT_WALL_CLOCK_MS
        );
    }

    #[test]
    fn requested_timeout_is_honoured_up_to_the_foreground_ceiling() {
        let limits = ResourceLimits::default();
        assert_eq!(
            resolve_exec_timeout_ms(300_000, &limits, MAX_FOREGROUND_WALL_CLOCK_MS),
            300_000,
            "a 5 minute test run must not be clamped to 60 s"
        );
        assert_eq!(
            resolve_exec_timeout_ms(600_000, &limits, MAX_FOREGROUND_WALL_CLOCK_MS),
            600_000
        );
        assert_eq!(
            resolve_exec_timeout_ms(3_600_000, &limits, MAX_FOREGROUND_WALL_CLOCK_MS),
            MAX_FOREGROUND_WALL_CLOCK_MS
        );
    }

    #[test]
    fn background_jobs_get_thirty_minutes_but_never_more() {
        let limits = ResourceLimits::default();
        assert_eq!(
            resolve_exec_timeout_ms(1_500_000, &limits, MAX_BACKGROUND_WALL_CLOCK_MS),
            1_500_000
        );
        assert_eq!(
            resolve_exec_timeout_ms(u64::MAX, &limits, MAX_BACKGROUND_WALL_CLOCK_MS),
            MAX_BACKGROUND_WALL_CLOCK_MS
        );
    }

    #[test]
    fn profile_ceiling_still_binds_when_the_call_site_asks_for_more() {
        let limits = ResourceLimits {
            max_wall_clock_ms: Some(5_000),
            ..ResourceLimits::default()
        };
        assert_eq!(
            resolve_exec_timeout_ms(60_000, &limits, MAX_BACKGROUND_WALL_CLOCK_MS),
            5_000
        );
    }

    #[test]
    fn scratch_dir_is_discovered_by_prefix() {
        let mut profile = SandboxProfile::default_restrictive();
        assert_eq!(profile.scratch_dir(), None);
        profile.filesystem.push(FilesystemRule {
            path: format!("/private/tmp/{SCRATCH_DIR_PREFIX}deadbeef"),
            access: FilesystemAccess::ReadWrite,
        });
        assert_eq!(
            profile.scratch_dir(),
            Some(format!("/private/tmp/{SCRATCH_DIR_PREFIX}deadbeef").as_str())
        );
    }
}

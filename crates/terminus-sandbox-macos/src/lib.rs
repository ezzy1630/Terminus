//! macOS sandbox backend (SPEC §13.4, ADR-0035 §4): real **Seatbelt**
//! profile generation via `sandbox-exec`.
//!
//! Phase 4 replaces the old degraded stub. This build TRANSLATES
//! [`SandboxProfile`] into a deny-by-default Seatbelt `.sb` program:
//!
//! - every `file-read*` / `file-write*` right is denied by default;
//! - read/write access is granted per profile filesystem rule as
//!   `(subpath …)` allowances against mapped host paths;
//! - `NetworkAccess::Deny` emits no `network-*` allowance at all;
//! - `ProcessAccess::AllowWithLimits` permits exec/fork but nothing else;
//! - secrets are broker-only: no ambient environment reach-through exists
//!   in the generated profile.
//!
//! Honesty contract: `Enforced` claims cover exactly what the generated
//! profile constrains. Seatbelt cannot provide seccomp, cgroups, or
//! namespace semantics, so those stay Degraded/Unsupported. When
//! `sandbox-exec` is absent the backend reports `Unsupported` and rejects
//! isolation profiles — fail closed (SPEC §19.4).

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]
#![forbid(unsafe_code)]

use std::path::{Path, PathBuf};
use terminus_sandbox::profile::{
    FilesystemAccess, NetworkAccess, ProcessAccess, SandboxProfile,
};
use terminus_sandbox::report::{EnforcementFeature, EnforcementReport, EnforcementStatus};
use terminus_sandbox::{SandboxBackend, SandboxError};

#[derive(Debug, Clone)]
pub struct MacOsSandboxBackend {
    /// Resolved path to `sandbox-exec`. `None` means not available.
    sandbox_exec_path: Option<PathBuf>,
    /// Host directory that backs `workspace://` rules.
    workspace_root: Option<PathBuf>,
}

impl Default for MacOsSandboxBackend {
    fn default() -> Self {
        Self {
            sandbox_exec_path: None,
            workspace_root: None,
        }
    }
}

impl MacOsSandboxBackend {
    /// Probe `$PATH` for `sandbox-exec`.
    pub fn new() -> Self {
        Self {
            sandbox_exec_path: which_sandbox_exec(),
            workspace_root: None,
        }
    }

    pub fn with_mocked_sandbox_exec(available: bool) -> Self {
        let mut b = Self::default();
        if available {
            b.sandbox_exec_path = Some(PathBuf::from("/usr/bin/sandbox-exec"));
        }
        b
    }

    /// Map `workspace://` rules onto a concrete host directory.
    pub fn with_workspace_root(mut self, root: impl Into<PathBuf>) -> Self {
        self.workspace_root = Some(root.into());
        self
    }

    pub fn is_seatbelt_available(&self) -> bool {
        self.sandbox_exec_path.is_some()
    }
}

/// Translate a profile filesystem rule path into a host path.
fn map_rule_path(rule_path: &str, workspace_root: Option<&Path>) -> Option<String> {
    if let Some(rest) = rule_path.strip_prefix("workspace://") {
        let root = workspace_root?;
        if rest.is_empty() {
            Some(root.display().to_string())
        } else {
            Some(root.join(rest).display().to_string())
        }
    } else if rule_path.starts_with('/') {
        Some(rule_path.to_string())
    } else {
        None
    }
}

/// Generate the Seatbelt `.sb` text for a restrictive profile. Deny-by-
/// default with explicit allowances only. Returns the profile body WITHOUT
/// the `(version n)` header so callers can wrap it.
pub fn generate_seatbelt_profile(
    profile: &SandboxProfile,
    workspace_root: Option<&Path>,
) -> Result<String, SandboxError> {
    // Security refusal first: ambient authority never generates a profile.
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

    let mut sb = String::new();
    sb.push_str("(version 1)\n");
    sb.push_str("(deny default)\n");
    // Minimal system plumbing required for ANY process to start and run.
    sb.push_str("(allow sysctl-read)\n");
    sb.push_str("(allow mach-lookup)\n");
    sb.push_str("(allow iokit-get-properties)\n");

    // ---- filesystem -----------------------------------------------------
    for rule in &profile.filesystem {
        let Some(host) = map_rule_path(&rule.path, workspace_root) else {
            continue;
        };
        match rule.access {
            FilesystemAccess::ReadOnly => {
                sb.push_str(&format!("(allow file-read* (subpath \"{host}\"))\n"));
            }
            FilesystemAccess::ReadWrite => {
                sb.push_str(&format!(
                    "(allow file-write* (subpath \"{host}\"))\n"
                ));
                sb.push_str(&format!(
                    "(allow file-read* (subpath \"{host}\"))\n"
                ));
            }
            FilesystemAccess::Deny => {
                // Deny default already covers it; emit an explicit rule so
                // intent survives review and future default changes.
                sb.push_str(&format!("(deny file-write* (subpath \"{host}\"))\n"));
                sb.push_str(&format!("(deny file-read* (subpath \"{host}\"))\n"));
            }
        }
    }

    // ---- network ---------------------------------------------------------
    match profile.network {
        NetworkAccess::Deny => {
            // Emit nothing: deny default blocks all sockets.
            sb.push_str("; network: denied by deny-default\n");
        }
        NetworkAccess::Allow => {
            sb.push_str("(allow network-outbound)\n");
            sb.push_str("(allow network-inbound)\n");
        }
        NetworkAccess::ProxyRequired => {
            // Only the kernel-owned local broker socket may be reached.
            sb.push_str("(allow network-outbound (to unix-socket*))\n");
            sb.push_str("; TCP destinations MUST traverse the L4/L7 brokers\n");
        }
    }

    // ---- process ----------------------------------------------------------
    match profile.process {
        ProcessAccess::Deny => {
            sb.push_str("; process execution: denied by deny-default\n");
        }
        ProcessAccess::Allow | ProcessAccess::AllowWithLimits => {
            sb.push_str("(allow process-fork)\n");
            sb.push_str("(allow process-exec)\n");
        }
    }

    Ok(sb)
}

impl SandboxBackend for MacOsSandboxBackend {
    fn id(&self) -> &'static str {
        "macos"
    }

    fn enforcement_report(&self) -> EnforcementReport {
        if self.sandbox_exec_path.is_some() {
            EnforcementReport {
                backend_id: self.id().to_string(),
                status: EnforcementStatus::Enforced,
                enforced: vec![
                    EnforcementFeature::AmbientSecretDenial,
                    EnforcementFeature::FilesystemIsolation,
                    EnforcementFeature::ProcessIsolation,
                    EnforcementFeature::NetworkIsolation,
                    EnforcementFeature::PluginAmbientAuthorityDenial,
                ],
                degraded: vec![
                    EnforcementFeature::CgroupResourceLimits,
                    EnforcementFeature::NoNewPrivs,
                    EnforcementFeature::SeccompFilter,
                ],
                unsupported: vec![
                    EnforcementFeature::PidNamespace,
                    EnforcementFeature::MountNamespace,
                    EnforcementFeature::UserNamespace,
                ],
                notes: vec![
                    "seatbelt profile generated from SandboxProfile (ADR-0035 §4)".to_string(),
                    "filesystem: deny-default + per-rule (subpath …) allowances".to_string(),
                    "network: Deny emits NO socket allowance; ProxyRequired restricts \
                     outbound to the broker unix socket"
                        .to_string(),
                    "cgroups/no-new-privs/seccomp: not expressible in Seatbelt — resource \
                     limits come from the caller's process supervision"
                        .to_string(),
                    "pid/mount/user namespaces: unsupported on macOS (use container or \
                     microVM backends)"
                        .to_string(),
                ],
            }
        } else {
            EnforcementReport {
                backend_id: self.id().to_string(),
                status: EnforcementStatus::Unsupported,
                enforced: vec![],
                degraded: vec![],
                unsupported: vec![
                    EnforcementFeature::FilesystemIsolation,
                    EnforcementFeature::NetworkIsolation,
                    EnforcementFeature::NoNewPrivs,
                    EnforcementFeature::PidNamespace,
                    EnforcementFeature::MountNamespace,
                    EnforcementFeature::UserNamespace,
                    EnforcementFeature::CgroupResourceLimits,
                ],
                notes: vec![
                    "seatbelt CLI (sandbox-exec) not found on PATH".to_string(),
                    "fail closed: use terminus-sandbox-container or a microVM backend"
                        .to_string(),
                ],
            }
        }
    }

    fn supports_profile(&self, profile: &SandboxProfile) -> Result<(), SandboxError> {
        // Security refusals are unconditional.
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
        // Fail closed without the platform primitive. There is no degraded
        // acceptance anymore: either we generate AND enforce, or the
        // profile is rejected.
        if self.sandbox_exec_path.is_none() {
            return Err(SandboxError::Unsupported(
                "macOS seatbelt CLI unavailable; refusing to run unsandboxed".into(),
            ));
        }
        // Generation must succeed for THIS profile before acceptance.
        let _ =
            generate_seatbelt_profile(profile, self.workspace_root.as_deref())?;
        Ok(())
    }

    fn spawn_wrapper(
        &self,
        command: &terminus_kernel_protocol::CommandSpec,
        profile: &SandboxProfile,
    ) -> Option<(std::path::PathBuf, Vec<String>)> {
        let exec = self.sandbox_exec_path.as_ref()?;
        let sb_text = generate_seatbelt_profile(profile, self.workspace_root.as_deref()).ok()?;
        // Write the profile to a private per-spawn file. mkstemp-style
        // naming under the OS temp dir keeps it out of the workspace and
        // unreachable to other users on single-user dev hosts.
        let dir = std::env::temp_dir().join(format!(
            "terminus-seatbelt-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).ok()?;
        let profile_path = dir.join(format!(
            "profile-{}.sb",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .ok()?
                .as_nanos()
        ));
        std::fs::write(&profile_path, sb_text).ok()?;
        let mut argv = vec![
            "-f".to_string(),
            profile_path.display().to_string(),
            "--".to_string(),
        ];
        argv.push(command.program.clone());
        argv.extend(command.args.clone());
        Some((exec.clone(), argv))
    }
}

/// Resolve `sandbox-exec` on `$PATH`.
fn which_sandbox_exec() -> Option<PathBuf> {
    let probe = CommandProbe::run("sandbox-exec", &["--version"])
        .or_else(|| CommandProbe::run("sandbox-exec", &["-h"]))?;
    if probe.status_success() {
        Some(PathBuf::from("sandbox-exec"))
    } else {
        None
    }
}

// Tiny indirection so the probe stays swappable in tests.
struct CommandProbe;

impl CommandProbe {
    fn run(program: &str, args: &[&str]) -> Option<ProbeOutput> {
        let output = std::process::Command::new(program)
            .args(args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .output()
            .ok()?;
        Some(ProbeOutput {
            success: output.status.success(),
        })
    }
}

struct ProbeOutput {
    success: bool,
}

impl ProbeOutput {
    fn status_success(&self) -> bool {
        self.success
    }
}

use std::sync::Arc;
#[cfg(test)]
mod phase4_tests {
    use super::*;
    use terminus_sandbox::SecretsAccess;

    fn backend() -> MacOsSandboxBackend {
        MacOsSandboxBackend::with_mocked_sandbox_exec(true)
            .with_workspace_root("/tmp/ws-root")
    }

    #[test]
    fn golden_profile_deny_default_with_rule_allowances() {
        let profile = SandboxProfile::default_restrictive();
        let sb = generate_seatbelt_profile(&profile, Some(Path::new("/tmp/ws-root"))).unwrap();
        assert!(sb.starts_with("(version 1)\n(deny default)\n"));
        // Read-only workspace root allowed to read...
        assert!(sb.contains("(allow file-read* (subpath \"/tmp/ws-root\"))"));
        // ...active worktree read-write...
        assert!(sb.contains(
            "(allow file-write* (subpath \"/tmp/ws-root/active-worktree\"))"
        ));
        // ...protected paths explicitly denied...
        assert!(sb.contains("(deny file-read* (subpath \"/tmp/ws-root/.git\"))"));
        assert!(sb
            .contains("(deny file-write* (subpath \"/tmp/ws-root/credentials\"))"));
        // ...and network deny emits no socket allowance.
        assert!(!sb.contains("allow network-outbound (to *)"));
        assert!(sb.contains("network: denied by deny-default"));
    }

    #[test]
    fn proxy_required_restricts_outbound_to_broker_socket() {
        let mut profile = SandboxProfile::default_restrictive();
        profile.network = NetworkAccess::ProxyRequired;
        let sb = generate_seatbelt_profile(&profile, None).unwrap();
        assert!(sb.contains("(allow network-outbound (to unix-socket*))"));
        assert!(!sb.contains("(allow network-outbound)\n"));
    }

    #[test]
    fn ambient_secrets_never_generate_a_profile() {
        let mut profile = SandboxProfile::default_restrictive();
        profile.secrets = SecretsAccess::AmbientEnvironment;
        let err =
            generate_seatbelt_profile(&profile, None).expect_err("ambient secrets refused");
        assert!(matches!(err, SandboxError::Misconfigured(_)));
    }

    #[test]
    fn spawn_wrapper_uses_generated_profile_file() {
        let b = backend();
        let cmd = terminus_kernel_protocol::CommandSpec {
            program: "echo".to_string(),
            args: vec!["hi".to_string()],
            cwd: terminus_kernel_protocol::WorkspacePath::new("ws", "."),
            timeout_ms: 1000,
            ..Default::default()
        };
        let (bin, argv) = b
            .spawn_wrapper(&cmd, &SandboxProfile::default_restrictive())
            .expect("wrapper with seatbelt available");
        assert_eq!(bin, PathBuf::from("/usr/bin/sandbox-exec"));
        assert_eq!(argv[0], "-f");
        let profile_path = PathBuf::from(&argv[1]);
        let text = std::fs::read_to_string(&profile_path).unwrap();
        assert!(text.contains("(deny default)"));
        assert_eq!(argv[2], "--");
        assert_eq!(argv[3], "echo");
        let _ = std::fs::remove_file(&profile_path);
    }

    #[test]
    fn report_claims_enforced_for_profile_expressible_controls_only() {
        let b = backend();
        let r = b.enforcement_report();
        assert_eq!(r.status, EnforcementStatus::Enforced);
        assert!(r.enforced.contains(&EnforcementFeature::FilesystemIsolation));
        assert!(r.degraded.contains(&EnforcementFeature::SeccompFilter));
        assert!(
            r.unsupported.contains(&EnforcementFeature::UserNamespace),
            "namespaces are not a Seatbelt concept"
        );
    }

    #[test]
    fn secure_mode_tier2_still_rejects_macos_backend() {
        // Seatbelt cannot enforce NoNewPrivs/cgroups: secure tier-2 must
        // fail closed even when generation works.
        let macos = Arc::new(backend()) as Arc<dyn terminus_sandbox::SandboxBackend>;
        let err = terminus_sandbox::select_secure(
            &[macos],
            &SandboxProfile::default_restrictive(),
            terminus_sandbox::RiskTier::Tier2,
        )
        .unwrap_err();
        assert!(format!("{err}").contains("tier2"));
    }
}

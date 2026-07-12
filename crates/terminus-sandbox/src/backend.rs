//! Sandbox backend trait and the default `LocalRestrictiveBackend`.

use crate::error::SandboxError;
use crate::profile::SandboxProfile;
use crate::report::{EnforcementFeature, EnforcementReport, EnforcementStatus};

/// A sandbox backend implements some subset of the sandbox profile. Each
/// backend MUST honestly report its effective enforcement.
pub trait SandboxBackend: Send + Sync + std::fmt::Debug {
    fn id(&self) -> &'static str;
    fn enforcement_report(&self) -> EnforcementReport;
    fn supports_profile(&self, profile: &SandboxProfile) -> Result<(), SandboxError>;

    /// If the backend can wrap a process spawn in an OS-level sandbox,
    /// return the wrapper binary path and the full argv (INCLUDING the
    /// trailing `-- <program> <args...>`). The caller runs
    /// `Command::new(binary).args(argv)`. Returning `None` means the
    /// backend does not wrap spawns (the caller spawns directly); the
    /// backend's `enforcement_report` MUST honestly reflect that.
    /// SPEC §13.4, §34.11.
    fn spawn_wrapper(
        &self,
        _command: &terminus_kernel_protocol::CommandSpec,
        _profile: &SandboxProfile,
    ) -> Option<(std::path::PathBuf, Vec<String>)> {
        None
    }
}

/// The default local backend. This is intentionally NOT a full namespace
/// sandbox; it enforces:
/// - process groups (for tree-kill on cancel);
/// - environment sanitization (deny ambient secrets);
/// - working directory jail (caller-supplied absolute path);
/// - resource limits via `setrlimit` where available (on the platform-specific
///   subcrates).
///
/// It is honest that it does NOT provide filesystem isolation, seccomp, user
/// namespaces, or mount namespaces — that work belongs to
/// `terminus-sandbox-linux`'s bubblewrap backend.
#[derive(Debug, Clone, Default)]
pub struct LocalRestrictiveBackend;

impl LocalRestrictiveBackend {
    pub fn new() -> Self {
        Self
    }
}

impl SandboxBackend for LocalRestrictiveBackend {
    fn id(&self) -> &'static str {
        "local-restrictive"
    }

    fn enforcement_report(&self) -> EnforcementReport {
        EnforcementReport {
            backend_id: self.id().to_string(),
            status: EnforcementStatus::Degraded,
            enforced: vec![
                EnforcementFeature::ProcessIsolation,
                EnforcementFeature::AmbientSecretDenial,
                EnforcementFeature::PluginAmbientAuthorityDenial,
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
                "process groups: enforced via setpgid".to_string(),
                "environment: ambient secret keys are filtered".to_string(),
                "filesystem: no isolation; protected-path enforcement lives in terminus-fs"
                    .to_string(),
                "network: no isolation; egress policy lives in terminus-egress".to_string(),
            ],
        }
    }

    fn supports_profile(&self, profile: &SandboxProfile) -> Result<(), SandboxError> {
        // Local-restrictive requires brokered secrets (deny ambient).
        if matches!(
            profile.secrets,
            crate::profile::SecretsAccess::AmbientEnvironment
        ) {
            return Err(SandboxError::Misconfigured(
                "ambient secret environment is not permitted on LocalRestrictiveBackend".into(),
            ));
        }
        if profile.plugins_ambient_authority {
            return Err(SandboxError::Misconfigured(
                "ambient plugin authority is not permitted on LocalRestrictiveBackend".into(),
            ));
        }
        // Network: if profile requires isolation we cannot enforce it locally.
        if matches!(profile.network, crate::profile::NetworkAccess::Deny)
            || matches!(
                profile.network,
                crate::profile::NetworkAccess::ProxyRequired
            )
        {
            // We cannot enforce network isolation at the OS level; terminus-egress
            // provides a userspace allowlist that the caller must wire up.
            // That is a degraded control, not a hard error.
        }
        Ok(())
    }
}

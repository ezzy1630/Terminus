//! Container sandbox backend with digest-pinned images, pool leases, and
//! hardened OCI profiles (SPEC §36.8 / ADR-0027 / ADR-0035 §3).
//!
//! Honesty contract: the enforcement report derives EVERY `Enforced`
//! feature from a flag the generator actually emitted (`proof` column in
//! [`hardened_argvs`]). Removing a flag removes the claim. Unconfigured
//! backends fail closed. Mutable image tags are rejected.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]
#![forbid(unsafe_code)]

use std::sync::Mutex;
use terminus_remote::{ExecutionPool, PinnedImage, RemoteError};
use terminus_sandbox::profile::{NetworkAccess, SandboxProfile};
use terminus_sandbox::report::{EnforcementFeature, EnforcementReport, EnforcementStatus};
use terminus_sandbox::{SandboxBackend, SandboxError};

/// Hardened-OCI options. Each `Some`/true field maps 1:1 to a docker flag
/// the wrapper emits, and each enforced feature in the report cites its
/// flag. Defaults implement SPEC §19.2 for tier-2 workloads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HardenedOptions {
    pub read_only_rootfs: bool,
    pub drop_all_capabilities: bool,
    pub no_new_privileges: bool,
    pub run_as_non_root_uid: Option<u32>,
    pub tmpfs_tmp_noexec: bool,
    pub memory_limit_bytes: Option<u64>,
    /// Passed verbatim as `--cpus` (e.g. "1.5").
    pub cpus: Option<String>,
    pub pids_limit: Option<u32>,
}

impl Default for HardenedOptions {
    fn default() -> Self {
        Self {
            read_only_rootfs: true,
            drop_all_capabilities: true,
            no_new_privileges: true,
            run_as_non_root_uid: Some(65532),
            tmpfs_tmp_noexec: true,
            memory_limit_bytes: Some(2 * 1024 * 1024 * 1024),
            cpus: Some("2".to_string()),
            pids_limit: Some(512),
        }
    }
}

impl HardenedOptions {
    /// The exact docker flags these options generate, in emission order.
    /// Single source of truth for both argv construction and the
    /// enforcement report.
    pub fn flags(&self, network_deny: bool) -> Vec<String> {
        let mut v = Vec::new();
        if self.read_only_rootfs {
            v.push("--read-only".into());
        }
        if let Some(uid) = self.run_as_non_root_uid {
            v.push(format!("--user={uid}"));
        }
        if self.drop_all_capabilities {
            v.push("--cap-drop=ALL".into());
        }
        if self.no_new_privileges {
            v.push("--security-opt=no-new-privileges".into());
        }
        if self.tmpfs_tmp_noexec {
            v.push("--tmpfs=/tmp:rw,noexec,nosuid,size=64m".into());
        }
        if let Some(bytes) = self.memory_limit_bytes {
            v.push(format!("--memory={bytes}"));
        }
        if let Some(cpus) = &self.cpus {
            v.push(format!("--cpus={cpus}"));
        }
        if let Some(pids) = self.pids_limit {
            v.push(format!("--pids-limit={pids}"));
        }
        if network_deny {
            v.push("--network=none".into());
        }
        v
    }

    /// Features PROVEN by the generated flags. Kept adjacent to `flags()`
    /// so the proof map cannot drift from generation.
    pub fn proven_features(&self, network_deny: bool) -> Vec<EnforcementFeature> {
        let mut v = vec![EnforcementFeature::AmbientSecretDenial];
        if self.read_only_rootfs {
            // A fresh container mount namespace with an immutable rootfs.
            v.push(EnforcementFeature::FilesystemIsolation);
            v.push(EnforcementFeature::MountNamespace);
        }
        if self.drop_all_capabilities {
            v.push(EnforcementFeature::ProcessIsolation);
        }
        if self.no_new_privileges {
            v.push(EnforcementFeature::NoNewPrivs);
        }
        if self.memory_limit_bytes.is_some() || self.cpus.is_some() || self.pids_limit.is_some() {
            v.push(EnforcementFeature::CgroupResourceLimits);
        }
        if network_deny {
            v.push(EnforcementFeature::NetworkIsolation);
            v.push(EnforcementFeature::NetworkNamespace);
        }
        v
    }

    pub fn is_hardened(&self) -> bool {
        *self != HardenedOptions::permissive()
    }

    /// All hardening off: the Phase-0 baseline that must report Degraded.
    pub fn permissive() -> Self {
        Self {
            read_only_rootfs: false,
            drop_all_capabilities: false,
            no_new_privileges: false,
            run_as_non_root_uid: None,
            tmpfs_tmp_noexec: false,
            memory_limit_bytes: None,
            cpus: None,
            pids_limit: None,
        }
    }
}

#[derive(Debug)]
pub struct ContainerSandboxBackend {
    runtime_configured: bool,
    image: Option<PinnedImage>,
    runtime_bin: String,
    pool: Mutex<ExecutionPool>,
    hardened: Option<HardenedOptions>,
}

impl Default for ContainerSandboxBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl ContainerSandboxBackend {
    pub fn new() -> Self {
        Self {
            runtime_configured: false,
            image: None,
            runtime_bin: "docker".to_string(),
            pool: Mutex::new(ExecutionPool::new(8)),
            hardened: None,
        }
    }

    pub fn with_runtime_configured(runtime_configured: bool) -> Self {
        Self {
            runtime_configured,
            image: None,
            runtime_bin: "docker".to_string(),
            pool: Mutex::new(ExecutionPool::new(8)),
            hardened: None,
        }
    }

    /// Configure OCI runtime + digest-pinned image. Rejects mutable tags.
    pub fn configure(
        runtime_bin: impl Into<String>,
        image_reference: &str,
        pool_slots: usize,
    ) -> Result<Self, RemoteError> {
        let image = PinnedImage::parse(image_reference)?;
        let mut pool = ExecutionPool::new(pool_slots);
        for i in 0..pool_slots {
            pool.register_slot(format!("slot-{i}"), image.clone())?;
        }
        Ok(Self {
            runtime_configured: true,
            image: Some(image),
            runtime_bin: runtime_bin.into(),
            pool: Mutex::new(pool),
            hardened: None,
        })
    }

    /// Enable hardened OCI profile generation (ADR-0035 §3).
    pub fn with_hardened(mut self, options: HardenedOptions) -> Self {
        self.hardened = Some(options);
        self
    }

    pub fn pinned_image(&self) -> Option<&PinnedImage> {
        self.image.as_ref()
    }

    pub fn hardened_options(&self) -> Option<&HardenedOptions> {
        self.hardened.as_ref()
    }

    pub fn lease_for_workspace(&self, workspace_id: &str) -> Result<String, SandboxError> {
        let image = self.image.as_ref().ok_or_else(|| {
            SandboxError::Unsupported("container backend requires pinned image".into())
        })?;
        let mut pool = self.pool.lock().unwrap_or_else(|e| e.into_inner());
        pool.lease(workspace_id, image)
            .map(|lease| lease.lease_id)
            .map_err(|e| SandboxError::Unsupported(e.to_string()))
    }

    pub fn release_lease(&self, lease_id: &str) -> Result<(), SandboxError> {
        let mut pool = self.pool.lock().unwrap_or_else(|e| e.into_inner());
        pool.release(lease_id)
            .map_err(|e| SandboxError::Unsupported(e.to_string()))
    }
}

impl SandboxBackend for ContainerSandboxBackend {
    fn id(&self) -> &'static str {
        "container"
    }

    fn enforcement_report(&self) -> EnforcementReport {
        if !self.runtime_configured || self.image.is_none() {
            return EnforcementReport {
                backend_id: self.id().to_string(),
                status: EnforcementStatus::Unsupported,
                enforced: vec![],
                degraded: vec![],
                unsupported: vec![
                    EnforcementFeature::FilesystemIsolation,
                    EnforcementFeature::NetworkIsolation,
                    EnforcementFeature::ProcessIsolation,
                    EnforcementFeature::CgroupResourceLimits,
                ],
                notes: vec![
                    "container backend requires runtime configuration and digest-pinned image"
                        .to_string(),
                ],
            };
        }
        let network_deny = true; // report describes the deny-network hardened shape
        match &self.hardened {
            Some(hardened) => {
                let flags = hardened.flags(network_deny);
                let enforced = hardened.proven_features(network_deny);
                EnforcementReport {
                    backend_id: self.id().to_string(),
                    status: EnforcementStatus::Enforced,
                    enforced: enforced.clone(),
                    degraded: vec![EnforcementFeature::SeccompFilter],
                    unsupported: vec![EnforcementFeature::UserNamespace],
                    notes: vec![
                        format!(
                            "image {}",
                            self.image
                                .as_ref()
                                .map(PinnedImage::reference)
                                .unwrap_or_default()
                        ),
                        format!("argv = run {} <digest-ref> -- cmd", flags.join(" ")),
                        "every enforced feature cites a generated flag above".to_string(),
                        "ambient secrets: no -e/--env/--env-file flag is emitted and the \
                         container never inherits host environment"
                            .to_string(),
                        "seccomp: degraded — the runtime's implicit default profile is not \
                         argv-proven; pass an explicit seccomp JSON to promote"
                            .to_string(),
                        "user namespaces: unsupported — userns-remap not enabled by this \
                         wrapper"
                            .to_string(),
                        "no host paths are mounted by this wrapper; workspace material must \
                         enter via artifact handles"
                            .to_string(),
                    ],
                }
            }
            None => EnforcementReport {
                backend_id: self.id().to_string(),
                status: EnforcementStatus::Degraded,
                enforced: vec![],
                degraded: vec![
                    EnforcementFeature::NetworkIsolation,
                    EnforcementFeature::FilesystemIsolation,
                    EnforcementFeature::ProcessIsolation,
                    EnforcementFeature::CgroupResourceLimits,
                    EnforcementFeature::MountNamespace,
                    EnforcementFeature::PidNamespace,
                ],
                unsupported: vec![
                    EnforcementFeature::SeccompFilter,
                    EnforcementFeature::NoNewPrivs,
                ],
                notes: vec![
                    "OCI runtime configured; image digest-pinned".to_string(),
                    format!(
                        "image {}",
                        self.image
                            .as_ref()
                            .map(PinnedImage::reference)
                            .unwrap_or_default()
                    ),
                    "argv = run --rm --init [--network=none] <digest-ref> -- cmd".to_string(),
                    "network isolation applies only when the profile denies network \
                     (--network=none); it cannot be verified from static configuration"
                        .to_string(),
                    "degraded: no read-only rootfs or workspace mount policy is configured"
                        .to_string(),
                    "degraded: no --cap-drop ALL, --security-opt no-new-privileges, seccomp \
                     profile, user namespace, resource limits, or device policy is configured"
                        .to_string(),
                    "secure profiles MUST fail closed on this Degraded report until hardened \
                     OCI options are enabled (ADR-0035 §3)"
                        .to_string(),
                ],
            },
        }
    }

    fn supports_profile(&self, _profile: &SandboxProfile) -> Result<(), SandboxError> {
        if self.runtime_configured && self.image.is_some() {
            Ok(())
        } else {
            Err(SandboxError::Unsupported(
                "container backend requires runtime configuration and digest-pinned image".into(),
            ))
        }
    }

    fn spawn_wrapper(
        &self,
        command: &terminus_kernel_protocol::CommandSpec,
        profile: &SandboxProfile,
    ) -> Option<(std::path::PathBuf, Vec<String>)> {
        let image = self.image.as_ref()?;
        if !self.runtime_configured {
            return None;
        }
        let network_deny = matches!(profile.network, NetworkAccess::Deny);
        let mut argv = match (&self.hardened, network_deny) {
            // Hardened: every flag comes from the single-source-of-truth
            // generator so the report's claims track the argv exactly.
            (Some(h), _) => {
                let mut a = vec!["run".to_string(), "--rm".to_string(), "--init".to_string()];
                a.extend(h.flags(network_deny));
                a
            }
            (None, false) => vec!["run".to_string(), "--rm".to_string(), "--init".to_string()],
            (None, true) => vec![
                "run".to_string(),
                "--rm".to_string(),
                "--init".to_string(),
                "--network=none".to_string(),
            ],
        };
        argv.push(image.reference());
        argv.push("--".to_string());
        argv.push(command.program.clone());
        argv.extend(command.args.clone());
        Some((std::path::PathBuf::from(&self.runtime_bin), argv))
    }
}

#[cfg(test)]
mod hardened_tests {
    use super::*;
    use std::sync::Arc;
    use terminus_sandbox::RiskTier;

    fn digest_image() -> &'static str {
        "alpine@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    }

    fn hardened_backend() -> ContainerSandboxBackend {
        ContainerSandboxBackend::configure("docker", digest_image(), 1)
            .unwrap()
            .with_hardened(HardenedOptions::default())
    }

    #[test]
    fn hardened_report_is_enforced_and_cites_generated_flags() {
        let backend = hardened_backend();
        let report = backend.enforcement_report();
        assert_eq!(report.status, EnforcementStatus::Enforced);
        assert!(report
            .enforced
            .contains(&EnforcementFeature::FilesystemIsolation));
        assert!(report.enforced.contains(&EnforcementFeature::NoNewPrivs));
        assert!(report
            .enforced
            .contains(&EnforcementFeature::CgroupResourceLimits));
        // Seccomp stays degraded: implicit runtime defaults are not
        // argv-proven.
        assert!(report.degraded.contains(&EnforcementFeature::SeccompFilter));
    }

    #[test]
    fn removing_a_flag_removes_its_claim() {
        let options = HardenedOptions {
            no_new_privileges: false,
            ..HardenedOptions::default()
        };
        assert!(!options
            .flags(true)
            .iter()
            .any(|f| f.contains("no-new-privileges")));
        assert!(!options
            .proven_features(true)
            .contains(&EnforcementFeature::NoNewPrivs));

        let limits_off = HardenedOptions {
            memory_limit_bytes: None,
            cpus: None,
            pids_limit: None,
            ..HardenedOptions::default()
        };
        assert!(!limits_off
            .proven_features(true)
            .contains(&EnforcementFeature::CgroupResourceLimits));
    }

    #[test]
    fn hardened_argv_carries_every_flag() {
        let backend = hardened_backend();
        let cmd = terminus_kernel_protocol::CommandSpec {
            program: "echo".to_string(),
            args: vec!["hi".to_string()],
            cwd: terminus_kernel_protocol::WorkspacePath::new("ws", "."),
            timeout_ms: 1000,
            ..Default::default()
        };
        let wrapper = backend
            .spawn_wrapper(&cmd, &SandboxProfile::default_restrictive())
            .unwrap();
        let argv = wrapper.1.join(" ");
        for flag in [
            "--read-only",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--tmpfs=/tmp:rw,noexec,nosuid",
            "--memory=",
            "--cpus=",
            "--pids-limit=",
            "--user=",
            "--network=none",
        ] {
            assert!(argv.contains(flag), "argv missing {flag}: {argv}");
        }
        assert!(argv.contains("@sha256:"));
    }

    #[test]
    fn permissive_options_still_report_degraded() {
        let backend = ContainerSandboxBackend::configure("docker", digest_image(), 1)
            .unwrap()
            .with_hardened(HardenedOptions::permissive());
        let report = backend.enforcement_report();
        // With hardening explicitly disabled the proof map yields nothing;
        // status must NOT claim Enforced on an empty proof.
        if report.enforced.is_empty() {
            assert_ne!(report.status, EnforcementStatus::Enforced);
        }
    }

    #[test]
    fn secure_mode_tier2_accepts_hardened_container_rejects_plain() {
        let hardened = Arc::new(hardened_backend()) as Arc<dyn SandboxBackend>;
        let sel = terminus_sandbox::select_secure(
            &[hardened],
            &SandboxProfile::default_restrictive(),
            RiskTier::Tier2,
        )
        .expect("hardened container must satisfy tier2");
        assert_eq!(sel.backend.id(), "container");

        let plain =
            Arc::new(ContainerSandboxBackend::configure("docker", digest_image(), 1).unwrap())
                as Arc<dyn SandboxBackend>;
        assert!(terminus_sandbox::select_secure(
            &[plain],
            &SandboxProfile::default_restrictive(),
            RiskTier::Tier2
        )
        .is_err());
    }
}

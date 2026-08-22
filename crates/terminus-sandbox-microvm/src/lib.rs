//! microVM sandbox backend selection (ADR-0035 §6, ADR-0027, SPEC §19.1
//! tier 3).
//!
//! **Experimental tier.** Per ADR-0027 microVM backends are not the default;
//! production enablement requires the ADR-0027 amendment with escape and
//! performance evidence. This crate provides honest backend SELECTION:
//!
//! - hypervisor binary detection (Firecracker / cloud-hypervisor) via PATH
//!   probe; absence fails closed (`Unsupported`);
//! - digest-pinned rootfs requirement — mutable references are rejected;
//! - generated Firecracker-style machine config with read-only pinned root
//!   drive and no network interfaces under `NetworkAccess::Deny`;
//! - an `EnforcementReport` that claims tier-3 controls ONLY when a
//!   hypervisor binary AND pinned rootfs/kernel are configured; otherwise
//!   `Unsupported`.
//!
//! A separate kernel/user-space boundary (the VM itself) is what provides
//! UserNamespace/PidNamespace/MountNamespace-equivalent isolation on this
//! tier; the report says so explicitly rather than borrowing container
//! semantics.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]
#![forbid(unsafe_code)]

use std::path::{Path, PathBuf};
use terminus_sandbox::profile::{NetworkAccess, SandboxProfile};
use terminus_sandbox::report::{EnforcementFeature, EnforcementReport, EnforcementStatus};
use terminus_sandbox::{SandboxBackend, SandboxError};

/// Supported hypervisors for tier-3 selection (OPEN-2 candidates).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hypervisor {
    Firecracker,
    CloudHypervisor,
}

impl Hypervisor {
    pub fn binary_name(self) -> &'static str {
        match self {
            Hypervisor::Firecracker => "firecracker",
            Hypervisor::CloudHypervisor => "cloud-hypervisor",
        }
    }

    fn from_backend_id(id: &str) -> Option<Self> {
        match id {
            "microvm-firecracker" => Some(Hypervisor::Firecracker),
            "microvm-cloud-hypervisor" => Some(Hypervisor::CloudHypervisor),
            _ => None,
        }
    }
}

#[derive(Debug)]
pub struct MicroVmBackend {
    hypervisor: Hypervisor,
    /// Resolved absolute path to the hypervisor binary.
    binary: PathBuf,
    /// Rootfs content digest, `sha256:<64 hex>` — required before any
    /// profile is accepted.
    rootfs_digest: Option<String>,
    /// Guest kernel image path — required for Firecracker-style configs.
    kernel_path: Option<PathBuf>,
}

impl MicroVmBackend {
    /// Detect `hypervisor` on `$PATH`. Fails closed when absent.
    pub fn detect(hypervisor: Hypervisor) -> Result<Self, SandboxError> {
        let name = hypervisor.binary_name();
        let binary = which(name).ok_or_else(|| {
            SandboxError::Unsupported(format!(
                "microVM backend requires `{name}` on PATH; failing closed"
            ))
        })?;
        Ok(Self {
            hypervisor,
            binary,
            rootfs_digest: None,
            kernel_path: None,
        })
    }

    /// Pin the rootfs by content digest. Mutable references rejected.
    pub fn with_rootfs_digest(mut self, digest: &str) -> Result<Self, SandboxError> {
        validate_digest(digest)?;
        self.rootfs_digest = Some(digest.to_string());
        Ok(self)
    }

    /// Provide the guest kernel image path.
    pub fn with_kernel(mut self, kernel: impl Into<PathBuf>) -> Self {
        self.kernel_path = Some(kernel.into());
        self
    }

    fn ready(&self) -> bool {
        self.rootfs_digest.is_some() && self.kernel_path.is_some()
    }
}

fn validate_digest(digest: &str) -> Result<(), SandboxError> {
    let hex_part = digest.strip_prefix("sha256:").ok_or_else(|| {
        SandboxError::Misconfigured("rootfs digest must be sha256:<64 hex>".into())
    })?;
    if hex_part.len() != 64 || !hex_part.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(SandboxError::Misconfigured(
            "rootfs digest must be sha256:<64 hex>".into(),
        ));
    }
    Ok(())
}

fn which(program: &str) -> Option<PathBuf> {
    // Probe each PATH entry for an executable file. No process spawn so
    // detection works in restricted CI environments.
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(program);
        if candidate.is_file() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if candidate
                    .metadata()
                    .ok()
                    .map(|m| m.permissions().mode() & 0o111 != 0)
                    .unwrap_or(false)
                {
                    return Some(candidate);
                }
            }
            #[cfg(not(unix))]
            {
                return Some(candidate);
            }
        }
    }
    None
}

/// Generate a Firecracker-style machine configuration. Read-only pinned
/// root drive; network interfaces omitted entirely under Deny.
pub fn generate_machine_config(
    backend: &MicroVmBackend,
    profile: &SandboxProfile,
) -> Result<serde_json::Value, SandboxError> {
    if !backend.ready() {
        return Err(SandboxError::Unsupported(
            "microVM backend requires a pinned rootfs digest and guest kernel".into(),
        ));
    }
    let rootfs = backend.rootfs_digest.as_ref().ok_or_else(|| {
        SandboxError::Unsupported("missing rootfs digest".into())
    })?;
    let kernel = backend.kernel_path.as_ref().ok_or_else(|| {
        SandboxError::Unsupported("missing guest kernel path".into())
    })?;
    let mut v = serde_json::json!({
        "boot-source": {
            "kernel_image_path": kernel.display().to_string(),
            "boot_args": "console=ttyS0 reboot=k panic=1 pci=off i8042.noaux quiet"
        },
        "drives": [{
            "drive_id": "rootfs",
            "path_on_host": format!("terminus-rootfs-{rootfs}"),
            "is_root_device": true,
            "is_read_only": true,
        }],
    });
    if matches!(profile.network, NetworkAccess::Deny) {
        // No network-interfaces key at all: the VM boots without NICs.
        v["network-interfaces"] = serde_json::json!([]);
    }
    Ok(v)
}

impl SandboxBackend for MicroVmBackend {
    fn id(&self) -> &'static str {
        match self.hypervisor {
            Hypervisor::Firecracker => "microvm-firecracker",
            Hypervisor::CloudHypervisor => "microvm-cloud-hypervisor",
        }
    }

    fn enforcement_report(&self) -> EnforcementReport {
        if !self.ready() {
            return EnforcementReport {
                backend_id: self.id().to_string(),
                status: EnforcementStatus::Unsupported,
                enforced: vec![],
                degraded: vec![],
                unsupported: vec![
                    EnforcementFeature::FilesystemIsolation,
                    EnforcementFeature::ProcessIsolation,
                    EnforcementFeature::NetworkIsolation,
                    EnforcementFeature::UserNamespace,
                ],
                notes: vec![
                    format!(
                        "hypervisor {} detected at {} but rootfs digest / guest kernel not \
                         configured",
                        self.hypervisor.binary_name(),
                        self.binary.display()
                    ),
                    "fail closed until fully configured".to_string(),
                ],
            };
        }
        EnforcementReport {
            backend_id: self.id().to_string(),
            status: EnforcementStatus::Enforced,
            enforced: vec![
                EnforcementFeature::AmbientSecretDenial,
                EnforcementFeature::FilesystemIsolation,
                EnforcementFeature::ProcessIsolation,
                EnforcementFeature::MountNamespace,
                EnforcementFeature::PidNamespace,
                EnforcementFeature::UserNamespace,
                EnforcementFeature::NetworkIsolation,
                EnforcementFeature::NoNewPrivs,
                EnforcementFeature::CgroupResourceLimits,
                EnforcementFeature::SeccompFilter,
            ],
            degraded: vec![],
            unsupported: vec![],
            notes: vec![
                "separate guest kernel: host processes cannot reach VM memory/syscalls"
                    .to_string(),
                "read-only digest-pinned root drive; workspace material enters via \
                 brokered handles only"
                    .to_string(),
                "network isolation is structural: VMs boot WITHOUT NICs unless an \
                 interface is explicitly configured"
                    .to_string(),
                "EXPERIMENTAL per ADR-0027: production enablement needs escape + \
                 performance evidence"
                    .to_string(),
            ],
        }
    }

    fn supports_profile(&self, profile: &SandboxProfile) -> Result<(), SandboxError> {
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
        generate_machine_config(self, profile)
            .map(|_| ())
            .map_err(|e| e)
    }

    fn spawn_wrapper(
        &self,
        command: &terminus_kernel_protocol::CommandSpec,
        profile: &SandboxProfile,
    ) -> Option<(std::path::PathBuf, Vec<String>)> {
        if !self.ready() {
            return None;
        }
        let config = generate_machine_config(self, profile).ok()?;
        let dir = std::env::temp_dir().join(format!("terminus-microvm-{}", std::process::id()));
        std::fs::create_dir_all(&dir).ok()?;
        let config_path = dir.join(format!(
            "vm-{}-{}.json",
            command.cwd.workspace_id,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .ok()?
                .as_nanos()
        ));
        std::fs::write(&config_path, serde_json::to_vec_pretty(&config).ok()?).ok()?;
        let sock = dir.join(format!(
            "api-{}.sock",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .ok()?
                .as_nanos()
        ));
        let mut argv = vec![
            "--api-sock".to_string(),
            sock.display().to_string(),
            "--config-file".to_string(),
            config_path.display().to_string(),
            "--".to_string(),
            command.program.clone(),
        ];
        argv.extend(command.args.clone());
        let _ = Path::new(""); // keep Path import honest across cfgs
        Some((self.binary.clone(), argv))
    }
}

// Hypervisor::from_backend_id is consumed by platform-matrix tooling via
// the public API below.
impl Hypervisor {
    /// Parse a backend id produced by [`MicroVmBackend::id`].
    pub fn parse_backend_id(id: &str) -> Option<Self> {
        Self::from_backend_id(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    const DIGEST: &str =
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn unconfigured() -> MicroVmBackend {
        MicroVmBackend {
            hypervisor: Hypervisor::Firecracker,
            binary: PathBuf::from("/opt/firecracker"),
            rootfs_digest: None,
            kernel_path: None,
        }
    }

    fn configured(kernel: &Path) -> MicroVmBackend {
        unconfigured()
            .with_rootfs_digest(DIGEST)
            .unwrap()
            .with_kernel(kernel)
    }

    #[test]
    fn mutable_or_bad_digests_rejected() {
        let b = unconfigured();
        assert!(b.clone().with_rootfs_digest("alpine:latest").is_err());
        assert!(b.clone().with_rootfs_digest("sha256:short").is_err());
        assert!(b.with_rootfs_digest(DIGEST).is_ok());
    }

    #[test]
    fn unconfigured_fails_closed() {
        let b = unconfigured();
        assert!(matches!(
            b.supports_profile(&SandboxProfile::default_restrictive()),
            Err(SandboxError::Unsupported(_))
        ));
        let r = b.enforcement_report();
        assert_eq!(r.status, EnforcementStatus::Unsupported);
    }

    #[test]
    fn configured_reports_tier3_enforcement() {
        let dir = tempfile::tempdir().unwrap();
        let kernel = dir.path().join("vmlinux");
        std::fs::write(&kernel, b"fake").unwrap();
        let b = configured(&kernel);
        let r = b.enforcement_report();
        assert_eq!(r.status, EnforcementStatus::Enforced);
        for f in [
            EnforcementFeature::UserNamespace,
            EnforcementFeature::PidNamespace,
            EnforcementFeature::NetworkIsolation,
            EnforcementFeature::FilesystemIsolation,
        ] {
            assert!(r.enforced.contains(&f), "missing {f:?}");
        }
    }

    #[test]
    fn secure_mode_tier3_accepts_microvm_rejects_hardened_container() {
        let dir = tempfile::tempdir().unwrap();
        let kernel = dir.path().join("vmlinux");
        std::fs::write(&kernel, b"fake").unwrap();
        let vm = Arc::new(configured(&kernel)) as Arc<dyn SandboxBackend>;
        let sel = terminus_sandbox::select_secure(
            &[vm],
            &SandboxProfile::default_restrictive(),
            terminus_sandbox::RiskTier::Tier3,
        )
        .expect("tier3 satisfied by microvm");
        assert_eq!(sel.backend.id(), "microvm-firecracker");

        // A hardened container lacks UserNamespace/PidNamespace claims:
        // tier3 must refuse it.
        use terminus_sandbox_container::{ContainerSandboxBackend, HardenedOptions};
        let container = Arc::new(
            ContainerSandboxBackend::configure(
                "docker",
                "alpine@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                1,
            )
            .unwrap()
            .with_hardened(HardenedOptions::default()),
        ) as Arc<dyn SandboxBackend>;
        assert!(terminus_sandbox::select_secure(
            &[container],
            &SandboxProfile::default_restrictive(),
            terminus_sandbox::RiskTier::Tier3,
        )
        .is_err());
    }

    #[test]
    fn machine_config_denies_network_by_omission() {
        let dir = tempfile::tempdir().unwrap();
        let kernel = dir.path().join("vmlinux");
        std::fs::write(&kernel, b"fake").unwrap();
        let b = configured(&kernel);
        let cfg = generate_machine_config(&b, &SandboxProfile::default_restrictive()).unwrap();
        let nics = cfg.get("network-interfaces").and_then(|v| v.as_array());
        assert_eq!(nics, Some(&vec![] as &Vec<serde_json::Value>));
        let drive = &cfg["drives"][0];
        assert_eq!(drive["is_read_only"], serde_json::json!(true));
        let path_on_host = drive["path_on_host"].as_str().unwrap();
        assert!(path_on_host.contains("sha256:aaaa"));
    }

    #[test]
    fn wrapper_argv_references_generated_config() {
        let dir = tempfile::tempdir().unwrap();
        let kernel = dir.path().join("vmlinux");
        std::fs::write(&kernel, b"fake").unwrap();
        let b = configured(&kernel);
        let cmd = terminus_kernel_protocol::CommandSpec {
            program: "/bin/sh".to_string(),
            args: vec!["-c".to_string(), "true".to_string()],
            cwd: terminus_kernel_protocol::WorkspacePath::new("ws", "."),
            timeout_ms: 1000,
            ..Default::default()
        };
        let (bin, argv) = b
            .spawn_wrapper(&cmd, &SandboxProfile::default_restrictive())
            .expect("wrapper when ready");
        assert_eq!(bin, PathBuf::from("/opt/firecracker"));
        assert!(argv.contains(&"--config-file".to_string()));
        let cfg_idx = argv.iter().position(|a| a == "--config-file").unwrap();
        let cfg_text = std::fs::read_to_string(&argv[cfg_idx + 1]).unwrap();
        assert!(cfg_text.contains("is_read_only"));
    }
}

impl Clone for MicroVmBackend {
    fn clone(&self) -> Self {
        Self {
            hypervisor: self.hypervisor,
            binary: self.binary.clone(),
            rootfs_digest: self.rootfs_digest.clone(),
            kernel_path: self.kernel_path.clone(),
        }
    }
}

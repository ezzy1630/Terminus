//! Container sandbox backend with digest-pinned images and pool leases.
//!
//! SPEC §36.8 / ADR-0027: mutable tags are rejected. Unconfigured backends
//! fail closed. When configured, spawn uses `repo@sha256:…` only.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]
#![forbid(unsafe_code)]

use std::sync::Mutex;
use terminus_remote::{ExecutionPool, PinnedImage, RemoteError};
use terminus_sandbox::profile::SandboxProfile;
use terminus_sandbox::report::{EnforcementFeature, EnforcementReport, EnforcementStatus};
use terminus_sandbox::{SandboxBackend, SandboxError};

#[derive(Debug)]
pub struct ContainerSandboxBackend {
    runtime_configured: bool,
    image: Option<PinnedImage>,
    runtime_bin: String,
    pool: Mutex<ExecutionPool>,
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
        }
    }

    pub fn with_runtime_configured(runtime_configured: bool) -> Self {
        Self {
            runtime_configured,
            image: None,
            runtime_bin: "docker".to_string(),
            pool: Mutex::new(ExecutionPool::new(8)),
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
        })
    }

    pub fn pinned_image(&self) -> Option<&PinnedImage> {
        self.image.as_ref()
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
        if self.runtime_configured && self.image.is_some() {
            return EnforcementReport {
                backend_id: self.id().to_string(),
                status: EnforcementStatus::Enforced,
                enforced: vec![
                    EnforcementFeature::FilesystemIsolation,
                    EnforcementFeature::NetworkIsolation,
                    EnforcementFeature::ProcessIsolation,
                    EnforcementFeature::CgroupResourceLimits,
                    EnforcementFeature::MountNamespace,
                    EnforcementFeature::PidNamespace,
                ],
                degraded: vec![],
                unsupported: vec![
                    EnforcementFeature::SeccompFilter,
                    EnforcementFeature::NoNewPrivs,
                    EnforcementFeature::UserNamespace,
                ],
                notes: vec![
                    "OCI runtime configured".to_string(),
                    format!(
                        "image {}",
                        self.image
                            .as_ref()
                            .map(PinnedImage::reference)
                            .unwrap_or_default()
                    ),
                ],
            };
        }
        EnforcementReport {
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
        let mut argv = vec!["run".to_string(), "--rm".to_string(), "--init".to_string()];
        if matches!(
            profile.network,
            terminus_sandbox::profile::NetworkAccess::Deny
        ) {
            argv.push("--network=none".to_string());
        }
        argv.push(image.reference());
        argv.push("--".to_string());
        argv.push(command.program.clone());
        argv.extend(command.args.clone());
        Some((std::path::PathBuf::from(&self.runtime_bin), argv))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn container_fails_closed_when_unconfigured() {
        let backend = ContainerSandboxBackend::new();
        let err = backend
            .supports_profile(&SandboxProfile::default_restrictive())
            .unwrap_err();
        assert!(matches!(err, SandboxError::Unsupported(_)));
    }

    #[test]
    fn configure_rejects_mutable_tag() {
        let err = ContainerSandboxBackend::configure("docker", "alpine:latest", 1).unwrap_err();
        assert!(matches!(err, RemoteError::MutableImageTag));
    }

    #[test]
    fn container_supports_when_configured_with_digest() {
        let backend = ContainerSandboxBackend::configure(
            "docker",
            "alpine@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            2,
        )
        .unwrap();
        backend
            .supports_profile(&SandboxProfile::default_restrictive())
            .unwrap();
        let lease = backend.lease_for_workspace("ws-1").unwrap();
        backend.release_lease(&lease).unwrap();
    }

    #[test]
    fn spawn_wrapper_uses_digest_reference() {
        let backend = ContainerSandboxBackend::configure(
            "docker",
            "alpine@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            1,
        )
        .unwrap();
        let cmd = terminus_kernel_protocol::CommandSpec {
            program: "echo".to_string(),
            args: vec!["hello".to_string()],
            cwd: terminus_kernel_protocol::WorkspacePath::new("ws-1", "."),
            timeout_ms: 1000,
            ..Default::default()
        };
        let profile = SandboxProfile::default_restrictive();
        let wrapper = backend.spawn_wrapper(&cmd, &profile).unwrap();
        assert_eq!(wrapper.0, std::path::PathBuf::from("docker"));
        assert!(wrapper.1.iter().any(|a| a.contains("@sha256:")));
        assert!(!wrapper.1.iter().any(|a| a == "alpine:latest"));
    }
}

//! Windows sandbox backend (SPEC §13.4, ADR-0035 §5).
//!
//! Phase 4 decision: native AppContainer/Job Object wiring requires Win32
//! FFI (`unsafe`) under SPEC §44.2 and cannot be conformance-tested on the
//! current development hosts; this ADR does not authorize that unsafe
//! scope. The backend therefore reports `Unsupported` honestly and
//! restrictive profiles on Windows MUST be satisfied by the container or
//! microVM fallback backends (the roadmap's sanctioned "WSL2/VM fallback"
//! branch). Secure modes fail closed when no enforcing backend exists.
//!
//! There is deliberately NO degraded acceptance: a profile either gets a
//! real enforcing backend (container / microVM / future AppContainer) or
//! it is rejected.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]
#![forbid(unsafe_code)]

use terminus_sandbox::profile::SandboxProfile;
use terminus_sandbox::report::{EnforcementFeature, EnforcementReport, EnforcementStatus};
use terminus_sandbox::{SandboxBackend, SandboxError};

#[derive(Debug, Clone, Default)]
pub struct WindowsSandboxBackend {
    /// True iff compiled for Windows. AppContainer availability cannot be
    /// probed without Win32 FFI, which this build does not link.
    on_windows_host: bool,
}

impl WindowsSandboxBackend {
    pub fn new() -> Self {
        Self {
            on_windows_host: cfg!(target_os = "windows"),
        }
    }

    pub fn with_mocked_platform(on_windows: bool) -> Self {
        Self {
            on_windows_host: on_windows,
        }
    }

    pub fn is_appcontainer_wired(&self) -> bool {
        // No AppContainer implementation exists in this build — by design
        // (ADR-0035 §5). This predicate exists so callers can distinguish
        // "backend present" from "backend enforcing" in generated matrices.
        false
    }
}

impl SandboxBackend for WindowsSandboxBackend {
    fn id(&self) -> &'static str {
        "windows"
    }

    fn enforcement_report(&self) -> EnforcementReport {
        EnforcementReport {
            backend_id: self.id().to_string(),
            status: EnforcementStatus::Unsupported,
            enforced: vec![],
            degraded: vec![],
            unsupported: vec![
                EnforcementFeature::FilesystemIsolation,
                EnforcementFeature::NetworkIsolation,
                EnforcementFeature::SeccompFilter,
                EnforcementFeature::NoNewPrivs,
                EnforcementFeature::PidNamespace,
                EnforcementFeature::MountNamespace,
                EnforcementFeature::UserNamespace,
                EnforcementFeature::CgroupResourceLimits,
            ],
            notes: vec![
                if self.on_windows_host {
                    "AppContainer/Job Object wiring intentionally absent (ADR-0035 §5); \
                     unsafe Win32 FFI requires a dedicated ADR + conformance runners"
                        .to_string()
                } else {
                    "host is not Windows".to_string()
                },
                "fail closed: restrictive profiles MUST use the container or microVM \
                 fallback backend (WSL2/VM branch of the roadmap)"
                    .to_string(),
                "this backend never reports Degraded acceptance".to_string(),
            ],
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
        Err(SandboxError::Unsupported(
            "Windows native sandbox not implemented (ADR-0035 §5): route restrictive \
             profiles through the container or microVM fallback backends"
                .into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn windows_backend_always_fails_closed() {
        for on_windows in [true, false] {
            let backend = WindowsSandboxBackend::with_mocked_platform(on_windows);
            let err = backend
                .supports_profile(&SandboxProfile::default_restrictive())
                .expect_err("no profile may be accepted without a real enforcing backend");
            assert!(matches!(err, SandboxError::Unsupported(_)));
            let report = backend.enforcement_report();
            assert_eq!(report.status, EnforcementStatus::Unsupported);
            assert!(report.enforced.is_empty());
        }
    }

    #[test]
    fn windows_backend_rejects_ambient_secrets_unconditionally() {
        let mut profile = SandboxProfile::default_restrictive();
        profile.secrets = terminus_sandbox::SecretsAccess::AmbientEnvironment;
        let backend = WindowsSandboxBackend::with_mocked_platform(true);
        let err = backend.supports_profile(&profile).unwrap_err();
        assert!(matches!(err, SandboxError::Misconfigured(_)));
    }

    #[test]
    fn secure_mode_falls_through_windows_to_container() {
        // On a Windows host with only the windows backend present, tier2
        // selection must fail closed...
        let windows = Arc::new(WindowsSandboxBackend::with_mocked_platform(true))
            as Arc<dyn SandboxBackend>;
        assert!(terminus_sandbox::select_secure(
            &[windows],
            &SandboxProfile::default_restrictive(),
            terminus_sandbox::RiskTier::Tier2,
        )
        .is_err());
        // ...and succeed once the container fallback enforces.
        use terminus_sandbox_container::{ContainerSandboxBackend, HardenedOptions};
        let hardened = ContainerSandboxBackend::configure(
            "docker",
            "alpine@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            1,
        )
        .unwrap()
        .with_hardened(HardenedOptions::default());
        let container = Arc::new(hardened) as Arc<dyn SandboxBackend>;
        let sel = terminus_sandbox::select_secure(
            &[container],
            &SandboxProfile::default_restrictive(),
            terminus_sandbox::RiskTier::Tier2,
        )
        .expect("hardened container fallback satisfies tier2");
        assert_eq!(sel.backend.id(), "container");
    }
}

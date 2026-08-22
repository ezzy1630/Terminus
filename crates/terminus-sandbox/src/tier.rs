//! Sandbox risk tiers (SPEC §19.1) and secure-mode selection (§19.4).
//!
//! Policy selects the MINIMUM tier for a workload; secure modes refuse any
//! backend that does not enforce the tier's required controls. "Configured"
//! is never "Enforced": selection reads each backend's measured
//! [`EnforcementReport`], not its configuration flags.

use crate::error::SandboxError;
use crate::profile::SandboxProfile;
use crate::report::{EnforcementFeature, EnforcementStatus};
use crate::SandboxBackend;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Execution isolation tier. Higher tiers demand stronger measured controls.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RiskTier {
    /// Pure deterministic / read-only service.
    Tier0,
    /// Local restricted process.
    Tier1,
    /// Hardened container with explicit OCI policy.
    Tier2,
    /// microVM / VM with brokered I/O.
    Tier3,
    /// Dedicated isolated environment for high-risk workloads.
    Tier4,
}

impl RiskTier {
    /// Controls a backend MUST report as `Enforced` to satisfy this tier in
    /// secure mode. Every tier inherits the floors below it.
    pub fn required_features(self) -> Vec<EnforcementFeature> {
        let mut v = vec![EnforcementFeature::AmbientSecretDenial];
        if self >= RiskTier::Tier1 {
            v.push(EnforcementFeature::ProcessIsolation);
        }
        if self >= RiskTier::Tier2 {
            v.push(EnforcementFeature::FilesystemIsolation);
            v.push(EnforcementFeature::NoNewPrivs);
            v.push(EnforcementFeature::CgroupResourceLimits);
        }
        if self >= RiskTier::Tier3 {
            v.push(EnforcementFeature::NetworkIsolation);
            v.push(EnforcementFeature::PidNamespace);
            v.push(EnforcementFeature::UserNamespace);
        }
        v
    }

    pub fn label(self) -> &'static str {
        match self {
            RiskTier::Tier0 => "tier0-read-only-service",
            RiskTier::Tier1 => "tier1-local-restricted",
            RiskTier::Tier2 => "tier2-hardened-container",
            RiskTier::Tier3 => "tier3-microvm",
            RiskTier::Tier4 => "tier4-dedicated-environment",
        }
    }
}

/// Outcome of secure-mode selection: the chosen backend plus the gap list
/// for every rejected candidate (operator-visible truth, SPEC §19.4).
#[derive(Debug, Clone)]
pub struct SecureSelection {
    pub backend: Arc<dyn SandboxBackend>,
    pub tier: RiskTier,
    pub rejections: Vec<String>,
}

/// Select a backend for `profile` that ENFORCES every control required by
/// `min_tier`. Fails closed when no candidate does, naming each gap.
pub fn select_secure(
    candidates: &[Arc<dyn SandboxBackend>],
    profile: &SandboxProfile,
    min_tier: RiskTier,
) -> Result<SecureSelection, SandboxError> {
    let required = min_tier.required_features();
    let mut rejections = Vec::new();
    for backend in candidates {
        let id = backend.id();
        if let Err(e) = backend.supports_profile(profile) {
            rejections.push(format!("{id}: rejects profile: {e}"));
            continue;
        }
        let report = backend.enforcement_report();
        if matches!(report.status, EnforcementStatus::Unsupported) {
            rejections.push(format!("{id}: unsupported"));
            continue;
        }
        let missing: Vec<&EnforcementFeature> = required
            .iter()
            .filter(|f| !report.enforced.contains(f))
            .collect();
        if !missing.is_empty() {
            let names = missing
                .iter()
                .map(|f| format!("{f:?}"))
                .collect::<Vec<_>>()
                .join(", ");
            rejections.push(format!(
                "{id}: {} status lacks enforced {names}",
                match report.status {
                    EnforcementStatus::Enforced => "enforced",
                    EnforcementStatus::Degraded => "degraded",
                    EnforcementStatus::Unsupported => "unsupported",
                }
            ));
            continue;
        }
        return Ok(SecureSelection {
            backend: Arc::clone(backend),
            tier: min_tier,
            rejections,
        });
    }
    Err(SandboxError::Unsupported(format!(
        "secure mode: no backend enforces the controls required by {} \
         (candidates: {})",
        min_tier.label(),
        if rejections.is_empty() {
            "none available".to_string()
        } else {
            rejections.join("; ")
        }
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::LocalRestrictiveBackend;
    use crate::manager::SandboxManager;
    use crate::report::{EnforcementReport, EnforcementStatus};

    #[derive(Debug)]
    struct FullyEnforcedBackend;
    impl SandboxBackend for FullyEnforcedBackend {
        fn id(&self) -> &'static str {
            "test-full"
        }
        fn enforcement_report(&self) -> EnforcementReport {
            EnforcementReport {
                backend_id: self.id().to_string(),
                status: EnforcementStatus::Enforced,
                enforced: vec![
                    EnforcementFeature::AmbientSecretDenial,
                    EnforcementFeature::ProcessIsolation,
                    EnforcementFeature::FilesystemIsolation,
                    EnforcementFeature::NoNewPrivs,
                    EnforcementFeature::CgroupResourceLimits,
                    EnforcementFeature::NetworkIsolation,
                    EnforcementFeature::PidNamespace,
                    EnforcementFeature::UserNamespace,
                ],
                degraded: vec![],
                unsupported: vec![],
                notes: vec![],
            }
        }
        fn supports_profile(&self, _p: &SandboxProfile) -> Result<(), SandboxError> {
            Ok(())
        }
    }

    fn all_candidates(mgr: &SandboxManager) -> Vec<Arc<dyn SandboxBackend>> {
        let mut v = vec![mgr.default_backend().clone()];
        v.extend(mgr.fallback_backends().iter().cloned());
        v
    }

    #[test]
    fn tier_floor_accumulates() {
        assert_eq!(RiskTier::Tier0.required_features().len(), 1);
        assert!(RiskTier::Tier2
            .required_features()
            .contains(&EnforcementFeature::NoNewPrivs));
        assert!(RiskTier::Tier3
            .required_features()
            .contains(&EnforcementFeature::UserNamespace));
    }

    #[test]
    fn secure_mode_rejects_degraded_local_backend_for_tier2() {
        let mgr = SandboxManager::new();
        let candidates = all_candidates(&mgr);
        let err = select_secure(
            &candidates,
            &SandboxProfile::default_restrictive(),
            RiskTier::Tier2,
        )
        .unwrap_err();
        let msg = format!("{err}");
        assert!(msg.contains("local-restrictive"), "{msg}");
        assert!(msg.contains("tier2"), "{msg}");
    }

    #[test]
    fn secure_mode_accepts_enforcing_backend_for_tier2() {
        let enforcing: Arc<dyn SandboxBackend> = Arc::new(FullyEnforcedBackend);
        let ok = select_secure(
            &[enforcing],
            &SandboxProfile::default_restrictive(),
            RiskTier::Tier2,
        )
        .unwrap();
        assert_eq!(ok.backend.id(), "test-full");
    }

    #[test]
    fn local_backend_satisfies_tier1_only_when_process_isolation_enforced() {
        // LocalRestrictive reports Degraded overall but DOES enforce process
        // isolation; tier1 requires exactly that floor, so it passes.
        let local: Arc<dyn SandboxBackend> = Arc::new(LocalRestrictiveBackend::new());
        let sel = select_secure(
            &[local],
            &SandboxProfile::default_restrictive(),
            RiskTier::Tier1,
        )
        .expect("tier1 floor must be satisfiable by local-restrictive");
        assert_eq!(sel.backend.id(), "local-restrictive");
    }
}

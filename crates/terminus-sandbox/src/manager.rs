//! `SandboxManager` selects a backend per profile / platform.

use crate::backend::{LocalRestrictiveBackend, SandboxBackend};
use crate::error::SandboxError;
use crate::profile::SandboxProfile;
use crate::report::EnforcementReport;
use std::sync::Arc;

#[derive(Clone)]
pub struct SandboxManager {
    default_backend: Arc<dyn SandboxBackend>,
    fallbacks: Vec<Arc<dyn SandboxBackend>>,
}

impl std::fmt::Debug for SandboxManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SandboxManager")
            .field("default_backend", &self.default_backend.id())
            .field(
                "fallbacks",
                &self.fallbacks.iter().map(|b| b.id()).collect::<Vec<_>>(),
            )
            .finish()
    }
}

impl SandboxManager {
    /// Construct with `LocalRestrictiveBackend` as the default. Platform
    /// backends (linux/macos/windows/container) can be registered as
    /// fallbacks via `with_fallback`.
    pub fn new() -> Self {
        Self {
            default_backend: Arc::new(LocalRestrictiveBackend::new()),
            fallbacks: Vec::new(),
        }
    }

    pub fn with_default(mut self, backend: Arc<dyn SandboxBackend>) -> Self {
        self.default_backend = backend;
        self
    }

    pub fn with_fallback(mut self, backend: Arc<dyn SandboxBackend>) -> Self {
        self.fallbacks.push(backend);
        self
    }

    /// Select a backend that supports `profile`. The default backend is
    /// preferred; fallbacks are tried in registration order. If the default
    /// backend rejects the profile as misconfigured (a security refusal, not
    /// a capability gap), that error is propagated verbatim so callers can
    /// distinguish "unsafe profile" from "no backend available".
    pub fn select(
        &self,
        profile: &SandboxProfile,
    ) -> Result<Arc<dyn SandboxBackend>, SandboxError> {
        match self.default_backend.supports_profile(profile) {
            Ok(()) => return Ok(Arc::clone(&self.default_backend)),
            Err(e @ SandboxError::Misconfigured(_)) => {
                // Security refusal: do not silently fall through to a weaker
                // backend. Propagate the misconfiguration error verbatim.
                return Err(e);
            }
            Err(_) => {}
        }
        for fb in &self.fallbacks {
            if fb.supports_profile(profile).is_ok() {
                return Ok(Arc::clone(fb));
            }
        }
        Err(SandboxError::Unsupported(format!(
            "no backend supports profile `{}`",
            profile.id
        )))
    }

    pub fn default_backend(&self) -> &Arc<dyn SandboxBackend> {
        &self.default_backend
    }

    pub fn enforcement_report(&self) -> EnforcementReport {
        self.default_backend.enforcement_report()
    }
}

impl Default for SandboxManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::{SandboxProfile, SecretsAccess};
    use crate::report::EnforcementStatus;

    #[test]
    fn local_restrictive_supports_default_profile() {
        let mgr = SandboxManager::new();
        let profile = SandboxProfile::default_restrictive();
        let backend = mgr.select(&profile).unwrap();
        assert_eq!(backend.id(), "local-restrictive");
    }

    #[test]
    fn local_restrictive_rejects_ambient_secrets() {
        let mgr = SandboxManager::new();
        let mut profile = SandboxProfile::default_restrictive();
        profile.secrets = SecretsAccess::AmbientEnvironment;
        let err = mgr.select(&profile).unwrap_err();
        assert!(matches!(err, SandboxError::Misconfigured(_)));
    }

    #[test]
    fn enforcement_report_is_degraded_not_enforced() {
        let mgr = SandboxManager::new();
        let report = mgr.enforcement_report();
        // We are honest: local-restrictive does NOT provide namespace isolation.
        assert_eq!(report.status, EnforcementStatus::Degraded);
        assert!(!report.unsupported.is_empty());
    }
}

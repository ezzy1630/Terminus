//! Enforcement report — the backend's honest self-description.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnforcementStatus {
    Enforced,
    Degraded,
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnforcementFeature {
    FilesystemIsolation,
    NetworkIsolation,
    NetworkNamespace,
    ProxyOnlyEgress,
    ProtectedGit,
    ProcessIsolation,
    ProcessTreeContainment,
    SeccompFilter,
    NoNewPrivs,
    CgroupResourceLimits,
    AmbientSecretDenial,
    SecretIsolation,
    PluginAmbientAuthorityDenial,
    PidNamespace,
    MountNamespace,
    UserNamespace,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnforcementReport {
    pub backend_id: String,
    pub status: EnforcementStatus,
    pub enforced: Vec<EnforcementFeature>,
    pub degraded: Vec<EnforcementFeature>,
    pub unsupported: Vec<EnforcementFeature>,
    pub notes: Vec<String>,
}

impl EnforcementReport {
    pub fn fail_closed_if_unsupported(&self) -> Result<(), crate::error::SandboxError> {
        if matches!(self.status, EnforcementStatus::Unsupported) {
            return Err(crate::error::SandboxError::Unsupported(format!(
                "backend {} is unsupported; failing closed",
                self.backend_id
            )));
        }
        Ok(())
    }
}

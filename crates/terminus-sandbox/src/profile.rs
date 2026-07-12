//! Sandbox profile (SPEC.md Section 13.3).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilesystemAccess {
    ReadOnly,
    ReadWrite,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ResourceLimits {
    pub cpu_ms: Option<u64>,
    pub memory_bytes: Option<u64>,
    pub pids: Option<u32>,
    pub wall_clock_ms: Option<u64>,
}

impl Default for ResourceLimits {
    fn default() -> Self {
        Self {
            cpu_ms: None,
            memory_bytes: None,
            pids: Some(256),
            wall_clock_ms: Some(60_000),
        }
    }
}

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

impl SandboxProfile {
    /// The default restrictive profile (SPEC.md Section 13.3).
    pub fn default_restrictive() -> Self {
        Self {
            id: "default-restrictive".to_string(),
            filesystem: vec![
                FilesystemRule {
                    path: "/".to_string(),
                    access: FilesystemAccess::ReadOnly,
                },
                FilesystemRule {
                    path: "workspace://".to_string(),
                    access: FilesystemAccess::ReadOnly,
                },
                FilesystemRule {
                    path: "workspace://active-worktree".to_string(),
                    access: FilesystemAccess::ReadWrite,
                },
                FilesystemRule {
                    path: "workspace://.git".to_string(),
                    access: FilesystemAccess::Deny,
                },
                FilesystemRule {
                    path: "workspace://.terminus".to_string(),
                    access: FilesystemAccess::Deny,
                },
                FilesystemRule {
                    path: "workspace://credentials".to_string(),
                    access: FilesystemAccess::Deny,
                },
            ],
            network: NetworkAccess::Deny,
            process: ProcessAccess::AllowWithLimits,
            secrets: SecretsAccess::BrokeredCapabilities,
            resources: ResourceLimits::default(),
            plugins_ambient_authority: false,
        }
    }
}

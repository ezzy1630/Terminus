//! Snapshot-first prepared environment blueprints (SPEC §36, §48.14).
//!
//! Parsing and validation are deliberately pure. Docker, Podman, microVM, and
//! credential brokers are transport/effect adapters owned by the kernel. A
//! blueprint is useful only after its image, snapshot, toolchain, dependency,
//! service, and credential references have been validated and content-hashed.

use crate::error::RemoteError;
use crate::image_pin::PinnedImage;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

const CURRENT_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlueprintBackend {
    Docker,
    Podman,
    RemoteMicrovm,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum NetworkPolicy {
    #[default]
    Deny,
    Allowlist,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolchainPin {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DependencyPin {
    pub manager: String,
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServiceBlueprint {
    pub name: String,
    pub image: String,
    #[serde(default)]
    pub command: Vec<String>,
    #[serde(default)]
    pub healthcheck: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrokeredCredential {
    pub name: String,
    /// Opaque `secret://...` or `oidc://...` capability reference. This is
    /// never a secret value and is the only credential form a blueprint may
    /// carry.
    pub capability: String,
    #[serde(default)]
    pub ttl_seconds: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvironmentBlueprint {
    pub schema_version: u32,
    pub name: String,
    /// Canonical OCI reference, for example `repo@sha256:<64 hex>`.
    pub base_image: String,
    /// Immutable content digest for the prepared/snapshotted environment.
    pub snapshot_digest: String,
    pub backend: BlueprintBackend,
    #[serde(default)]
    pub network: NetworkPolicy,
    #[serde(default)]
    pub toolchains: Vec<ToolchainPin>,
    #[serde(default)]
    pub dependencies: Vec<DependencyPin>,
    #[serde(default)]
    pub services: Vec<ServiceBlueprint>,
    #[serde(default)]
    pub credentials: Vec<BrokeredCredential>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedEnvironmentPlan {
    pub blueprint: EnvironmentBlueprint,
    pub base_image: PinnedImage,
    pub blueprint_digest: String,
    pub provider: BlueprintBackend,
}

impl EnvironmentBlueprint {
    /// Parse and validate the YAML contract before any provider is contacted.
    pub fn from_yaml(yaml: &str) -> Result<Self, RemoteError> {
        let blueprint: Self = serde_yaml::from_str(yaml).map_err(|error| {
            RemoteError::InvalidEnvironment(format!("invalid environment blueprint YAML: {error}"))
        })?;
        blueprint.validate()?;
        Ok(blueprint)
    }

    pub fn validate(&self) -> Result<(), RemoteError> {
        if self.schema_version != CURRENT_SCHEMA_VERSION {
            return Err(RemoteError::InvalidEnvironment(format!(
                "unsupported blueprint schema version {}; expected {CURRENT_SCHEMA_VERSION}",
                self.schema_version
            )));
        }
        require_name(&self.name, "blueprint name")?;
        let image = PinnedImage::parse(&self.base_image)?;
        validate_digest(&self.snapshot_digest, "snapshot_digest")?;
        if self.toolchains.is_empty() {
            return Err(RemoteError::InvalidEnvironment(
                "blueprint must pin at least one toolchain".into(),
            ));
        }
        let mut names = BTreeSet::new();
        for toolchain in &self.toolchains {
            require_name(&toolchain.name, "toolchain name")?;
            require_exact_pin(&toolchain.version, "toolchain version")?;
            if !names.insert(format!("toolchain:{}", toolchain.name)) {
                return Err(RemoteError::InvalidEnvironment(format!(
                    "duplicate toolchain: {}",
                    toolchain.name
                )));
            }
        }
        names.clear();
        for dependency in &self.dependencies {
            require_name(&dependency.manager, "dependency manager")?;
            require_name(&dependency.name, "dependency name")?;
            require_exact_pin(&dependency.version, "dependency version")?;
            if !names.insert(format!("{}:{}", dependency.manager, dependency.name)) {
                return Err(RemoteError::InvalidEnvironment(format!(
                    "duplicate dependency: {}:{}",
                    dependency.manager, dependency.name
                )));
            }
        }
        names.clear();
        for service in &self.services {
            require_name(&service.name, "service name")?;
            PinnedImage::parse(&service.image)?;
            if service.command.is_empty() || service.command.iter().any(|item| item.is_empty()) {
                return Err(RemoteError::InvalidEnvironment(format!(
                    "service {} must declare a non-empty command",
                    service.name
                )));
            }
            if !names.insert(service.name.clone()) {
                return Err(RemoteError::InvalidEnvironment(format!(
                    "duplicate service: {}",
                    service.name
                )));
            }
        }
        names.clear();
        for credential in &self.credentials {
            require_name(&credential.name, "credential name")?;
            if credential.ttl_seconds == 0 {
                return Err(RemoteError::InvalidEnvironment(format!(
                    "credential {} must have a positive TTL",
                    credential.name
                )));
            }
            if !(credential.capability.starts_with("secret://")
                || credential.capability.starts_with("oidc://"))
                || credential.capability.chars().any(char::is_whitespace)
                || credential.capability.contains('=')
            {
                return Err(RemoteError::InvalidEnvironment(format!(
                    "credential {} must reference an opaque secret:// or oidc:// capability",
                    credential.name
                )));
            }
            if !names.insert(credential.name.clone()) {
                return Err(RemoteError::InvalidEnvironment(format!(
                    "duplicate credential: {}",
                    credential.name
                )));
            }
        }
        // Keep the parse above explicit: a valid image is part of the plan and
        // must not be silently discarded by a future backend adapter.
        let _ = image;
        Ok(())
    }

    /// Build an immutable provider plan. This is the only output a provider
    /// adapter should receive before it returns a trusted prepared-environment
    /// receipt and lease; no provider process is started here.
    pub fn prepare_plan(&self) -> Result<PreparedEnvironmentPlan, RemoteError> {
        self.validate()?;
        let base_image = PinnedImage::parse(&self.base_image)?;
        Ok(PreparedEnvironmentPlan {
            blueprint: self.clone(),
            base_image,
            blueprint_digest: self.digest()?,
            provider: self.backend,
        })
    }

    /// Content identity of the parsed blueprint, independent of YAML layout.
    pub fn digest(&self) -> Result<String, RemoteError> {
        let canonical = serde_json::to_vec(self).map_err(|error| {
            RemoteError::InvalidEnvironment(format!("could not canonicalize blueprint: {error}"))
        })?;
        let mut hasher = Sha256::new();
        hasher.update(canonical);
        Ok(format!("sha256:{}", hex::encode(hasher.finalize())))
    }
}

fn require_name(value: &str, field: &str) -> Result<(), RemoteError> {
    if value.trim().is_empty() || value.chars().any(char::is_whitespace) {
        return Err(RemoteError::InvalidEnvironment(format!(
            "{field} must be a non-empty token"
        )));
    }
    Ok(())
}

fn require_exact_pin(value: &str, field: &str) -> Result<(), RemoteError> {
    if value.trim().is_empty() || matches!(value, "latest" | "*" | "^" | "~") {
        return Err(RemoteError::InvalidEnvironment(format!(
            "{field} must be exact and pinned"
        )));
    }
    if value.contains('*') || value.starts_with('^') || value.starts_with('~') {
        return Err(RemoteError::InvalidEnvironment(format!(
            "{field} must be exact and pinned"
        )));
    }
    Ok(())
}

fn validate_digest(value: &str, field: &str) -> Result<(), RemoteError> {
    let Some(hex_part) = value.strip_prefix("sha256:") else {
        return Err(RemoteError::InvalidEnvironment(format!(
            "{field} must be sha256:<64 hex>"
        )));
    };
    if hex_part.len() != 64
        || !hex_part
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err(RemoteError::InvalidEnvironment(format!(
            "{field} must be sha256:<64 hex>"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const YAML: &str = r#"
schema_version: 1
name: rust-workspace
base_image: ghcr.io/terminus/rust@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
snapshot_digest: sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
backend: remote_microvm
network: deny
toolchains:
  - name: rust
    version: 1.97.0
dependencies:
  - manager: cargo
    name: serde
    version: 1.0.219
services:
  - name: database
    image: ghcr.io/terminus/postgres@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
    command: [postgres, -c, fsync=on]
credentials:
  - name: github
    capability: secret://github/read
    ttl_seconds: 300
  - name: workload
    capability: oidc://github/actions
    ttl_seconds: 120
"#;

    #[test]
    fn parses_and_hashes_layout_independent_blueprint() {
        let blueprint = EnvironmentBlueprint::from_yaml(YAML).expect("valid blueprint");
        let plan = blueprint.prepare_plan().expect("valid plan");
        assert_eq!(plan.provider, BlueprintBackend::RemoteMicrovm);
        assert!(plan.blueprint_digest.starts_with("sha256:"));
        assert_eq!(plan.base_image.repository, "ghcr.io/terminus/rust");
    }

    #[test]
    fn rejects_mutable_images_and_secret_values() {
        let mutable = YAML.replace(
            "ghcr.io/terminus/rust@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "ghcr.io/terminus/rust:latest",
        );
        assert!(EnvironmentBlueprint::from_yaml(&mutable).is_err());
        let raw_secret = YAML.replace("secret://github/read", "token=raw-secret");
        assert!(EnvironmentBlueprint::from_yaml(&raw_secret).is_err());
    }

    #[test]
    fn rejects_unpinned_dependency_and_missing_service_command() {
        let floating = YAML.replace("version: 1.0.219", "version: ^1.0");
        assert!(EnvironmentBlueprint::from_yaml(&floating).is_err());
        let missing_command = YAML.replace("    command: [postgres, -c, fsync=on]\n", "");
        assert!(EnvironmentBlueprint::from_yaml(&missing_command).is_err());
    }
}

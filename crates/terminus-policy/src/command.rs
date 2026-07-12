//! Effect taxonomy (SPEC.md Section 27.3) and normalized command model
//! (Section 13.5, 31.4).

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// The full effect taxonomy the kernel MUST classify each requested effect
/// into. See SPEC.md Section 27.3.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EffectType {
    ReadLocal,
    WriteLocal,
    ExecuteLocal,
    NetworkRead,
    NetworkWrite,
    ExternalStateRead,
    ExternalStateWrite,
    SecretUse,
    ProcessControl,
    SandboxAdmin,
    PluginAdmin,
    CredentialAdmin,
}

impl EffectType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReadLocal => "READ_LOCAL",
            Self::WriteLocal => "WRITE_LOCAL",
            Self::ExecuteLocal => "EXECUTE_LOCAL",
            Self::NetworkRead => "NETWORK_READ",
            Self::NetworkWrite => "NETWORK_WRITE",
            Self::ExternalStateRead => "EXTERNAL_STATE_READ",
            Self::ExternalStateWrite => "EXTERNAL_STATE_WRITE",
            Self::SecretUse => "SECRET_USE",
            Self::ProcessControl => "PROCESS_CONTROL",
            Self::SandboxAdmin => "SANDBOX_ADMIN",
            Self::PluginAdmin => "PLUGIN_ADMIN",
            Self::CredentialAdmin => "CREDENTIAL_ADMIN",
        }
    }
}

/// A normalized description of a shell pipeline, command, or script that the
/// policy engine evaluates.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct NormalizedCommand {
    pub resolved_executable: String,
    pub argv: Vec<String>,
    pub shell_ast: Option<ShellAst>,
    pub redirections: Vec<Redirection>,
    pub working_directory: String,
    pub network_destinations: Vec<NetworkDestination>,
    pub secret_capabilities: Vec<String>,
    pub taint_sources: Vec<TaintSource>,
    pub effect_types: BTreeSet<EffectType>,
}

impl NormalizedCommand {
    pub fn new(resolved_executable: impl Into<String>) -> Self {
        Self {
            resolved_executable: resolved_executable.into(),
            ..Default::default()
        }
    }

    pub fn with_argv(mut self, argv: Vec<String>) -> Self {
        self.argv = argv;
        self
    }

    pub fn effects(&self) -> &BTreeSet<EffectType> {
        &self.effect_types
    }
}

/// Structured representation of a shell AST. The kernel currently records
/// only the top-level shape (pipeline / command / script); detailed grammar
/// analysis is delegated to the sandbox backend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ShellAst {
    Pipeline { stages: Vec<String> },
    SingleCommand { program: String, args: Vec<String> },
    Script { dialect: String, script: String },
    Unknown { raw: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Redirection {
    /// `> path` — overwrite.
    Write { path: String, append: bool },
    /// `< path` — input from file.
    Read { path: String },
    /// `2> path` — error output.
    StderrWrite { path: String, append: bool },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NetworkDestination {
    pub host: String,
    pub port: u16,
    pub scheme: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaintSource {
    pub kind: String,
    pub uri: String,
}

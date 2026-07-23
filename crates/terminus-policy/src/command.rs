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

impl ShellAst {
    /// Parse a raw shell command string into a structured `NormalizedCommand`.
    pub fn parse(raw: &str) -> NormalizedCommand {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return NormalizedCommand::default();
        }

        let mut redirections = Vec::new();
        let mut effect_types = BTreeSet::new();

        // Detect shell script patterns (multiline or explicit shebang)
        if trimmed.starts_with("#!") || trimmed.contains('\n') {
            effect_types.insert(EffectType::ExecuteLocal);
            let ast = ShellAst::Script {
                dialect: "bash".to_string(),
                script: trimmed.to_string(),
            };
            return NormalizedCommand {
                resolved_executable: "/bin/bash".to_string(),
                argv: vec![
                    "/bin/bash".to_string(),
                    "-c".to_string(),
                    trimmed.to_string(),
                ],
                shell_ast: Some(ast),
                redirections,
                working_directory: String::new(),
                network_destinations: Vec::new(),
                secret_capabilities: Vec::new(),
                taint_sources: Vec::new(),
                effect_types,
            };
        }

        // Check for pipeline (|)
        let is_pipeline = trimmed.contains('|');
        if is_pipeline {
            let stages: Vec<String> = trimmed.split('|').map(|s| s.trim().to_string()).collect();
            effect_types.insert(EffectType::ExecuteLocal);
            for stage in &stages {
                classify_stage_effects(stage, &mut effect_types, &mut redirections);
            }
            let ast = ShellAst::Pipeline { stages };
            let first_cmd = trimmed.split('|').next().unwrap_or("").trim();
            let tokens = shell_words(first_cmd);
            let prog = tokens.first().cloned().unwrap_or_default();
            return NormalizedCommand {
                resolved_executable: prog,
                argv: tokens,
                shell_ast: Some(ast),
                redirections,
                working_directory: String::new(),
                network_destinations: Vec::new(),
                secret_capabilities: Vec::new(),
                taint_sources: Vec::new(),
                effect_types,
            };
        }

        // Single command
        let mut tokens = Vec::new();
        let raw_tokens = shell_words(trimmed);
        let mut idx = 0;
        while idx < raw_tokens.len() {
            let tok = &raw_tokens[idx];
            if tok == ">>" && idx + 1 < raw_tokens.len() {
                redirections.push(Redirection::Write {
                    path: raw_tokens[idx + 1].clone(),
                    append: true,
                });
                effect_types.insert(EffectType::WriteLocal);
                idx += 2;
            } else if tok == ">" && idx + 1 < raw_tokens.len() {
                redirections.push(Redirection::Write {
                    path: raw_tokens[idx + 1].clone(),
                    append: false,
                });
                effect_types.insert(EffectType::WriteLocal);
                idx += 2;
            } else if tok == "<" && idx + 1 < raw_tokens.len() {
                redirections.push(Redirection::Read {
                    path: raw_tokens[idx + 1].clone(),
                });
                effect_types.insert(EffectType::ReadLocal);
                idx += 2;
            } else if tok == "2>" && idx + 1 < raw_tokens.len() {
                redirections.push(Redirection::StderrWrite {
                    path: raw_tokens[idx + 1].clone(),
                    append: false,
                });
                effect_types.insert(EffectType::WriteLocal);
                idx += 2;
            } else {
                tokens.push(tok.clone());
                idx += 1;
            }
        }

        let prog = tokens.first().cloned().unwrap_or_default();
        if !prog.is_empty() {
            effect_types.insert(EffectType::ExecuteLocal);
            classify_prog_effects(&prog, &mut effect_types);
        }
        if trimmed.contains("$SECRET") || trimmed.contains("secret://") {
            effect_types.insert(EffectType::SecretUse);
        }

        let ast = ShellAst::SingleCommand {
            program: prog.clone(),
            args: if tokens.len() > 1 {
                tokens[1..].to_vec()
            } else {
                Vec::new()
            },
        };

        NormalizedCommand {
            resolved_executable: prog,
            argv: tokens,
            shell_ast: Some(ast),
            redirections,
            working_directory: String::new(),
            network_destinations: Vec::new(),
            secret_capabilities: Vec::new(),
            taint_sources: Vec::new(),
            effect_types,
        }
    }
}

fn classify_stage_effects(
    stage: &str,
    effects: &mut BTreeSet<EffectType>,
    _redirections: &mut Vec<Redirection>,
) {
    let tokens = shell_words(stage);
    if let Some(prog) = tokens.first() {
        classify_prog_effects(prog, effects);
    }
    if stage.contains(">>") || stage.contains('>') {
        effects.insert(EffectType::WriteLocal);
    }
    if stage.contains('<') {
        effects.insert(EffectType::ReadLocal);
    }
    if stage.contains("$SECRET") || stage.contains("secret://") {
        effects.insert(EffectType::SecretUse);
    }
}

fn classify_prog_effects(prog: &str, effects: &mut BTreeSet<EffectType>) {
    let basename = std::path::Path::new(prog)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(prog);
    match basename {
        "cat" | "head" | "tail" | "grep" | "rg" | "ls" | "find" => {
            effects.insert(EffectType::ReadLocal);
        }
        "cp" | "mv" | "rm" | "touch" | "mkdir" | "sed" | "tee" => {
            effects.insert(EffectType::WriteLocal);
        }
        "curl" | "wget" | "nc" | "netcat" => {
            effects.insert(EffectType::NetworkWrite);
        }
        _ => {}
    }
}

fn shell_words(raw: &str) -> Vec<String> {
    raw.split_whitespace().map(|s| s.to_string()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_single_command_with_redirection() {
        let cmd = ShellAst::parse("echo hello > output.txt");
        assert_eq!(cmd.resolved_executable, "echo");
        assert_eq!(cmd.argv, vec!["echo", "hello"]);
        assert_eq!(
            cmd.redirections,
            vec![Redirection::Write {
                path: "output.txt".to_string(),
                append: false,
            }]
        );
        assert!(cmd.effect_types.contains(&EffectType::ExecuteLocal));
        assert!(cmd.effect_types.contains(&EffectType::WriteLocal));
    }

    #[test]
    fn parse_pipeline_command() {
        let cmd = ShellAst::parse("cat input.txt | grep foo");
        assert!(matches!(cmd.shell_ast, Some(ShellAst::Pipeline { .. })));
        assert!(cmd.effect_types.contains(&EffectType::ExecuteLocal));
        assert!(cmd.effect_types.contains(&EffectType::ReadLocal));
    }

    #[test]
    fn parse_secret_use_command() {
        let cmd =
            ShellAst::parse("curl -H 'Authorization: Bearer $SECRET' https://api.example.com");
        assert!(cmd.effect_types.contains(&EffectType::SecretUse));
        assert!(cmd.effect_types.contains(&EffectType::NetworkWrite));
    }
}

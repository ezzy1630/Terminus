//! YAML representation of a rule set.

use crate::command::EffectType;
use crate::decision::Constraint;
use crate::rule::{Rule, RuleEffect, RuleMatch, RuleSet};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuleSetFile {
    pub rules: Vec<RuleFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuleFile {
    pub id: String,
    pub description: String,
    pub priority: u32,
    pub r#match: RuleMatchFile,
    pub effect: RuleEffectFile,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RuleMatchFile {
    pub executable_any: Vec<String>,
    pub executable_prefix_any: Vec<String>,
    pub working_directory_glob: Vec<String>,
    pub effects_any: Vec<EffectType>,
    pub network_destinations_any: Vec<String>,
    pub argv_contains_any: Vec<String>,
    pub shell_script_contains_any: Vec<String>,
    pub secret_capability_prefix_any: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RuleEffectFile {
    Allow,
    AllowWithConstraints { constraint: ConstraintFile },
    Prompt,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ConstraintFile {
    pub max_runtime_ms: Option<u64>,
    pub max_output_bytes: Option<u64>,
    pub redact_patterns: Vec<String>,
    pub allowed_paths: Vec<String>,
    pub disallowed_env: Vec<String>,
}

impl ConstraintFile {
    fn into_constraint(self) -> Constraint {
        Constraint {
            max_runtime_ms: self.max_runtime_ms,
            max_output_bytes: self.max_output_bytes,
            redact_patterns: self.redact_patterns,
            allowed_paths: self.allowed_paths,
            disallowed_env: self.disallowed_env,
        }
    }
}

impl RuleMatchFile {
    fn into_match(self) -> RuleMatch {
        RuleMatch {
            executable_any: self.executable_any,
            executable_prefix_any: self.executable_prefix_any,
            working_directory_glob: self.working_directory_glob,
            effects_any: self.effects_any,
            network_destinations_any: self.network_destinations_any,
            argv_contains_any: self.argv_contains_any,
            shell_script_contains_any: self.shell_script_contains_any,
            secret_capability_prefix_any: self.secret_capability_prefix_any,
        }
    }
}

impl RuleSetFile {
    pub fn into_rule_set(self) -> RuleSet {
        let rules = self
            .rules
            .into_iter()
            .map(|r| Rule {
                id: r.id,
                description: r.description,
                priority: r.priority,
                r#match: r.r#match.into_match(),
                effect: match r.effect {
                    RuleEffectFile::Allow => RuleEffect::Allow,
                    RuleEffectFile::AllowWithConstraints { constraint } => {
                        RuleEffect::AllowWithConstraints(constraint.into_constraint())
                    }
                    RuleEffectFile::Prompt => RuleEffect::Prompt,
                    RuleEffectFile::Deny => RuleEffect::Deny,
                },
            })
            .collect();
        RuleSet { rules }
    }
}

/// The default rule set used when no policy profile is configured. Mirrors
/// `policies/command/default.yaml`.
pub fn default_rule_set() -> RuleSet {
    let yaml = sample_rule_set_yaml();
    let file: RuleSetFile = serde_yaml::from_str(&yaml).expect("default rule set parses");
    file.into_rule_set()
}

/// A representative default rule set YAML string. In production this is read
/// from `policies/command/default.yaml`.
///
/// NOTE: The policy engine's `RuleMatch::matches` uses OR semantics within
/// a rule — a rule matches if ANY of its non-empty match fields matches.
/// This means `effects_any` on a rule with other match fields makes the
/// rule overly broad (it matches every command with that effect type,
/// regardless of executable/argv). We therefore omit `effects_any` from
/// rules that already match on executable/argv/working_directory, and
/// reserve `effects_any` for rules that match ONLY on effect type (e.g.
/// `deny-external-state-write-default`).
pub fn sample_rule_set_yaml() -> String {
    r#"
rules:
  - id: allow-local-tests
    description: Allow common local test runners in the workspace
    priority: 10
    match:
      executable_any: ["pnpm", "pytest", "cargo", "go", "npm", "yarn", "bun"]
    effect:
      kind: allow_with_constraints
      constraint:
        max_runtime_ms: 600000
        max_output_bytes: 16777216
        disallowed_env: ["AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN"]

  - id: allow-read-tools
    description: Allow read-only inspection tools
    priority: 10
    match:
      executable_any: ["ls", "cat", "grep", "rg", "fd", "find", "git"]
    effect:
      kind: allow

  - id: prompt-git-push
    description: Prompt before any git push
    priority: 20
    match:
      executable_any: ["git"]
      argv_contains_any: ["push"]
    effect:
      kind: prompt

  - id: deny-download-pipe-interpreter
    description: Deny curl|bash style installation
    priority: 30
    match:
      executable_any: ["curl", "wget"]
      argv_contains_any: ["|", "bash", "sh", "python", "perl"]
    effect:
      kind: deny

  - id: deny-protected-path-write
    description: Deny writes to .git, .forge, credentials, .env
    priority: 50
    match:
      working_directory_glob: ["**/.git/**", "**/.forge/**", "**/credentials/**", "**/.env*"]
    effect:
      kind: deny

  - id: deny-external-state-write-default
    description: Default-deny external state mutations
    priority: 40
    match:
      effects_any: ["EXTERNAL_STATE_WRITE"]
    effect:
      kind: deny
"#
    .to_string()
}

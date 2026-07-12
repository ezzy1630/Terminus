use crate::command::EffectType;
use serde::{Deserialize, Serialize};

/// A policy decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    Allow,
    AllowWithConstraints,
    Prompt,
    Deny,
}

impl Decision {
    /// Strictness ranking used by the engine. Higher is stricter.
    pub fn rank(self) -> u8 {
        match self {
            Self::Allow => 0,
            Self::AllowWithConstraints => 1,
            Self::Prompt => 2,
            Self::Deny => 3,
        }
    }

    /// Combine two decisions: strictest wins.
    pub fn combine(self, other: Self) -> Self {
        if self.rank() >= other.rank() {
            self
        } else {
            other
        }
    }
}

/// Additional constraints attached to an `AllowWithConstraints` decision.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Constraint {
    pub max_runtime_ms: Option<u64>,
    pub max_output_bytes: Option<u64>,
    pub redact_patterns: Vec<String>,
    pub allowed_paths: Vec<String>,
    pub disallowed_env: Vec<String>,
}

/// A fully-evaluated decision report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DecisionReport {
    pub decision: Decision,
    pub rule_ids: Vec<String>,
    pub explanation: String,
    pub effects: Vec<EffectType>,
    pub constraints: Constraint,
    pub decision_id: String,
}

impl DecisionReport {
    pub fn allow(rule_ids: Vec<String>, explanation: impl Into<String>) -> Self {
        Self {
            decision: Decision::Allow,
            rule_ids,
            explanation: explanation.into(),
            effects: Vec::new(),
            constraints: Constraint::default(),
            decision_id: forge_kernel_protocol::new_id(),
        }
    }

    pub fn deny(rule_ids: Vec<String>, explanation: impl Into<String>) -> Self {
        Self {
            decision: Decision::Deny,
            rule_ids,
            explanation: explanation.into(),
            effects: Vec::new(),
            constraints: Constraint::default(),
            decision_id: forge_kernel_protocol::new_id(),
        }
    }
}

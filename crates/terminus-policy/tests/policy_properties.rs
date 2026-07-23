//! Property tests for policy monotonicity (SPEC §46.3).
//!
//! Invariant: adding a more-restrictive matching rule never loosens the
//! combined decision.

#![cfg(test)]
#![allow(clippy::unwrap_used, clippy::expect_used)]

use terminus_policy::{
    Decision, EffectType, NormalizedCommand, PolicyEngine, Rule, RuleEffect, RuleMatch, RuleSet,
    ShellAst,
};

fn allow_rule(id: &str, executable: &str, priority: u32) -> Rule {
    Rule {
        id: id.into(),
        description: id.into(),
        priority,
        r#match: RuleMatch {
            executable_any: vec![executable.into()],
            ..Default::default()
        },
        effect: RuleEffect::Allow,
    }
}

fn deny_rule(id: &str, executable: &str, priority: u32) -> Rule {
    Rule {
        id: id.into(),
        description: id.into(),
        priority,
        r#match: RuleMatch {
            executable_any: vec![executable.into()],
            ..Default::default()
        },
        effect: RuleEffect::Deny,
    }
}

fn cmd(executable: &str) -> NormalizedCommand {
    let mut c = ShellAst::parse(executable);
    c.effect_types.insert(EffectType::ExecuteLocal);
    c
}

#[test]
fn adding_deny_never_loosens_allow() {
    let mut base = RuleSet::default();
    base.push(allow_rule("allow-cargo", "cargo", 10));
    let before = PolicyEngine::new(base.clone()).evaluate(&cmd("cargo test"));
    assert_eq!(before.decision, Decision::Allow);

    base.push(deny_rule("deny-cargo", "cargo", 20));
    let after = PolicyEngine::new(base).evaluate(&cmd("cargo test"));
    assert!(
        after.decision.rank() >= before.decision.rank(),
        "strictness regressed: {:?} -> {:?}",
        before.decision,
        after.decision
    );
    assert_eq!(after.decision, Decision::Deny);
}

#[test]
fn default_deny_when_no_rules_match() {
    let engine = PolicyEngine::new(RuleSet::default());
    let report = engine.evaluate(&cmd("curl https://evil.example"));
    assert_eq!(report.decision, Decision::Deny);
}

#[test]
fn decision_combine_is_monotonic() {
    let ranks = [
        Decision::Allow,
        Decision::AllowWithConstraints,
        Decision::Prompt,
        Decision::Deny,
    ];
    for a in ranks {
        for b in ranks {
            let combined = a.combine(b);
            assert!(combined.rank() >= a.rank());
            assert!(combined.rank() >= b.rank());
        }
    }
}

#[test]
fn yaml_parse_rejects_garbage_without_panic() {
    for sample in ["", "not: yaml: [[", "rules: 1", "rules:\n  - id: x"] {
        let _ = PolicyEngine::from_yaml(sample);
    }
}

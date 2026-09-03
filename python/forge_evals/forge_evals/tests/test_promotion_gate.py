"""Promotion gate tests (SPEC §18.7, §41.12, §50)."""

from __future__ import annotations

from forge_evals.promotion_gate import (
    Evaluation,
    GateStatus,
    PromotionDecision,
    evaluate_promotion,
)


def _winning_evaluation() -> Evaluation:
    """Build an Evaluation that should pass every gate."""
    return Evaluation(
        primary_cohort="tiny_bugfix",
        primary_metric_delta=0.10,
        primary_ci_low=0.05,
        primary_ci_high=0.15,
        primary_effect_size=0.6,
        primary_effect_size_ci_low=0.2,
        primary_effect_size_ci_high=1.0,
        min_effect_size=0.3,
        security_guardrails={"workspace_escape": True, "network_bypass": True},
        security_guardrail_failed=False,
        pareto_improves=True,
        cost_delta_pct=-5.0,
        regression_cohorts=[],
        noninferiority_margin=0.05,
        noninferiority_cohorts=["refactor"],
        has_observability=True,
        has_rollback=True,
        has_documentation=True,
        has_migration_behavior=True,
        maintainability_within_budget=True,
        divergence_within_budget=True,
    )


def test_promotion_gate_all_pass_promotes() -> None:
    """All gates pass → PROMOTE."""
    result = evaluate_promotion(_winning_evaluation())
    assert result.decision is PromotionDecision.PROMOTE
    # The reliability gate is n/a without reliability evidence; every other
    # gate must actually pass.
    assert all(
        g.status is GateStatus.PASS or g.status is GateStatus.NOT_APPLICABLE
        for g in result.gates
    )
    assert result.passed


def test_promotion_gate_security_failure_blocks() -> None:
    """Security guardrail failure → BLOCKED → ROLLBACK."""
    ev = _winning_evaluation()
    # Replace with a failed guardrail.
    ev = Evaluation(
        **{
            **ev.__dict__,
            "security_guardrails": {"workspace_escape": False},
            "security_guardrail_failed": True,
        }
    )
    result = evaluate_promotion(ev)
    assert result.decision is PromotionDecision.ROLLBACK
    assert "security_guardrails" in result.blocking_gates
    # The security gate specifically returns BLOCKED.
    sec_gate = next(g for g in result.gates if g.name == "security_guardrails")
    assert sec_gate.status is GateStatus.BLOCKED


def test_promotion_gate_ci_includes_zero_fails_confidence() -> None:
    """CI including zero fails the confidence gate."""
    ev = _winning_evaluation()
    ev = Evaluation(
        **{
            **ev.__dict__,
            "primary_ci_low": -0.02,
            "primary_ci_high": 0.10,
            "primary_effect_size_ci_low": -0.1,
            "primary_effect_size_ci_high": 0.5,
        }
    )
    result = evaluate_promotion(ev)
    assert result.decision is not PromotionDecision.PROMOTE
    conf_gate = next(g for g in result.gates if g.name == "confidence_bounds")
    assert conf_gate.status is GateStatus.FAIL


def test_promotion_gate_regression_fails() -> None:
    """A regression in a critical cohort fails the regressions gate."""
    ev = _winning_evaluation()
    ev = Evaluation(**{**ev.__dict__, "regression_cohorts": ["security_sensitive"]})
    result = evaluate_promotion(ev)
    reg_gate = next(g for g in result.gates if g.name == "regressions")
    assert reg_gate.status is GateStatus.FAIL
    assert result.decision is PromotionDecision.REVISE


def test_promotion_gate_no_pareto_improvement_fails() -> None:
    """Below Pareto frontier with no hard need fails the Pareto gate."""
    ev = _winning_evaluation()
    ev = Evaluation(**{**ev.__dict__, "pareto_improves": False})
    result = evaluate_promotion(ev)
    par_gate = next(g for g in result.gates if g.name == "pareto_frontier")
    assert par_gate.status is GateStatus.FAIL


def test_promotion_gate_hard_security_need_overrides_pareto() -> None:
    """A hard security need overrides the Pareto requirement."""
    ev = _winning_evaluation()
    ev = Evaluation(
        **{**ev.__dict__, "pareto_improves": False, "satisfies_hard_security_need": True}
    )
    result = evaluate_promotion(ev)
    par_gate = next(g for g in result.gates if g.name == "pareto_frontier")
    assert par_gate.status is GateStatus.PASS
    assert "hard security/reliability need" in par_gate.detail


def test_promotion_gate_operations_fail_retains_experimental() -> None:
    """Operational-only failures with core passing → RETAIN_EXPERIMENTAL."""
    ev = _winning_evaluation()
    ev = Evaluation(**{**ev.__dict__, "has_documentation": False, "has_migration_behavior": False})
    result = evaluate_promotion(ev)
    assert result.decision is PromotionDecision.RETAIN_EXPERIMENTAL


def test_promotion_gate_maintainability_fail_with_other_fail_revise() -> None:
    """Maintainability failure plus confidence failure → REVISE (not retain)."""
    ev = _winning_evaluation()
    ev = Evaluation(
        **{
            **ev.__dict__,
            "maintainability_within_budget": False,
            "primary_ci_low": -0.02,  # also fails confidence
            "primary_ci_high": 0.10,
            "primary_effect_size_ci_low": -0.1,
            "primary_effect_size_ci_high": 0.5,
        }
    )
    result = evaluate_promotion(ev)
    assert result.decision is PromotionDecision.REVISE


def test_promotion_gate_min_effect_size_not_met_fails_confidence() -> None:
    """Effect size below min → confidence gate fails."""
    ev = _winning_evaluation()
    ev = Evaluation(
        **{
            **ev.__dict__,
            "primary_effect_size": 0.1,
            "min_effect_size": 0.3,
            "primary_effect_size_ci_low": 0.0,
            "primary_effect_size_ci_high": 0.2,
        }
    )
    result = evaluate_promotion(ev)
    conf_gate = next(g for g in result.gates if g.name == "confidence_bounds")
    assert conf_gate.status is GateStatus.FAIL


def test_promotion_gate_hard_reliability_need_overrides_pareto() -> None:
    """Hard reliability need also overrides Pareto."""
    ev = _winning_evaluation()
    ev = Evaluation(
        **{**ev.__dict__, "pareto_improves": False, "satisfies_hard_reliability_need": True}
    )
    result = evaluate_promotion(ev)
    par_gate = next(g for g in result.gates if g.name == "pareto_frontier")
    assert par_gate.status is GateStatus.PASS


def test_promotion_gate_passed_property_matches_decision() -> None:
    """``result.passed`` is True iff decision is PROMOTE."""
    ev_win = _winning_evaluation()
    assert evaluate_promotion(ev_win).passed

    ev_lose = Evaluation(
        **{
            **ev_win.__dict__,
            "security_guardrails": {"x": False},
            "security_guardrail_failed": True,
        }
    )
    assert not evaluate_promotion(ev_lose).passed


def test_promotion_gate_has_seven_gates() -> None:
    """Seven gates: Pareto, confidence, regressions, security, operations,
    maintainability, reliability (causal tier 3)."""
    result = evaluate_promotion(_winning_evaluation())
    assert len(result.gates) == 7
    names = {g.name for g in result.gates}
    assert names == {
        "pareto_frontier",
        "confidence_bounds",
        "regressions",
        "security_guardrails",
        "operations",
        "maintainability",
        "reliability",
    }


def test_promotion_gate_reliability_gate_present_without_evidence() -> None:
    """The reliability gate reports n/a when no reliability evidence exists."""
    result = evaluate_promotion(_winning_evaluation())
    reliability = next((g for g in result.gates if g.name == "reliability"), None)
    assert reliability is not None
    assert reliability.status is GateStatus.NOT_APPLICABLE


def test_promotion_gate_result_blocking_gates_property() -> None:
    """``blocking_gates`` lists the names of BLOCKED gates."""
    ev = _winning_evaluation()
    ev = Evaluation(
        **{**ev.__dict__, "security_guardrails": {"x": False}, "security_guardrail_failed": True}
    )
    result = evaluate_promotion(ev)
    assert "security_guardrails" in result.blocking_gates

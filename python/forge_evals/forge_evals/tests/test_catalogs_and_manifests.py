"""Cohort, baseline, and manifest catalog tests (SPEC §18.1, §18.2, §41.7)."""

from __future__ import annotations

import pytest

from forge_evals.baselines import (
    BASELINES,
    all_baseline_ids,
    baseline_by_id,
    canonical_baseline_id,
)
from forge_evals.cohort_tasks import COHORTS, cohort_by_id
from forge_evals.experiment_manifest import (
    ChangeManifest,
    Decision,
    ExperimentManifest,
    ObservedDeltas,
    PromotionRule,
    RollbackCondition,
    SamplePlan,
    StoppingRule,
)
from forge_evals.runners import ExternalHarnessUnavailable, get_baseline_harness


def test_cohort_catalog_has_nineteen_cohorts() -> None:
    """SPEC §18.2 lists 19 cohorts."""
    assert len(COHORTS) == 19


def test_cohort_ids_are_stable_and_unique() -> None:
    """Cohort ids are unique."""
    ids = [c.id for c in COHORTS]
    assert len(ids) == len(set(ids))


def test_cohort_by_id_returns_cohort() -> None:
    """cohort_by_id returns the matching cohort."""
    c = cohort_by_id("tiny_bugfix")
    assert c.name == "Tiny bug fix"
    assert c.task_count > 0


def test_cohort_by_id_unknown_raises() -> None:
    """Unknown cohort id raises KeyError."""
    with pytest.raises(KeyError):
        cohort_by_id("nonexistent")


def test_every_cohort_has_at_least_one_sample_task() -> None:
    """Every cohort has at least one sample task."""
    for c in COHORTS:
        assert len(c.sample_tasks) >= 1, f"{c.id} has no sample tasks"


def test_baseline_catalog_has_eight_baselines() -> None:
    """SPEC §18.1 baselines remain catalogued without becoming runtime dependencies."""
    assert len(BASELINES) == 8


def test_opencode_is_external_unconfigured_and_never_a_runtime_dependency() -> None:
    baseline = baseline_by_id("upstream_opencode")
    assert baseline.pin_kind == "unconfigured"
    assert not baseline.pin_verified
    assert not baseline.live_runner_available
    assert not baseline.first_party_runtime_dependency
    with pytest.raises(ExternalHarnessUnavailable, match="external comparison only"):
        get_baseline_harness("upstream_opencode")


def test_baseline_by_id_returns_baseline() -> None:
    """baseline_by_id returns the matching baseline."""
    b = baseline_by_id("forge_minimal")
    assert b.name == "Terminus minimal"
    assert b.pin_kind in ("git_commit", "image_digest", "release_tag")


def test_terminus_baselines_are_canonical_and_forge_names_are_aliases() -> None:
    assert "terminus-minimal" in all_baseline_ids()
    assert "terminus-full" in all_baseline_ids()
    assert "forge_minimal" not in all_baseline_ids()
    assert "forge_full" not in all_baseline_ids()
    assert canonical_baseline_id("forge_minimal") == "terminus-minimal"
    assert baseline_by_id("forge_minimal") is baseline_by_id("terminus-minimal")


def test_forge_minimal_supports_native_best_and_model_fixed() -> None:
    """Terminus minimal supports both comparison modes (SPEC §18.1)."""
    b = baseline_by_id("forge_minimal")
    assert b.supports_model_fixed
    assert b.supports_native_best


def test_claude_code_licensing_flag_present() -> None:
    """Claude Code's licensing_permits_automation flag is the source of truth."""
    b = baseline_by_id("claude_code")
    # The flag may be True or False depending on the deployment, but it must exist.
    assert hasattr(b, "licensing_permits_automation")
    assert isinstance(b.licensing_permits_automation, bool)


def test_change_manifest_yaml_round_trip(tmp_path: object) -> None:
    """ChangeManifest YAML round-trips."""
    m = ChangeManifest(
        hypothesis="memory improves unfamiliar_repository",
        target_cohort="unfamiliar_repository",
        changed_components=["memory"],
        predicted_improvements={"unfamiliar_repository": 0.10},
        predicted_regressions={},
        metrics=["primary_score"],
        budget={"max_cost_usd": 10.0},
        seeds=3,
        holdouts=["parallelizable_task"],
        rollback_condition=RollbackCondition(
            metric="primary", threshold=">= -0.05", action="rollback"
        ),
        owner="research",
    )
    yaml_text = m.to_yaml()
    assert "hypothesis:" in yaml_text
    m2 = ChangeManifest.from_yaml(yaml_text)
    assert m2.hypothesis == m.hypothesis
    assert m2.target_cohort == m.target_cohort
    assert m2.rollback_condition is not None
    assert m2.rollback_condition.metric == "primary"


def test_change_manifest_decision_attach() -> None:
    """make_decision attaches the post-run decision."""
    m = ChangeManifest(
        hypothesis="h",
        target_cohort="c",
        changed_components=["x"],
    )
    m.make_decision(Decision.PROMOTE, reason="all gates passed")
    assert m.decision is Decision.PROMOTE
    assert m.decision_reason == "all gates passed"


def test_change_manifest_rollback_condition_matches() -> None:
    """should_rollback triggers when the rollback condition matches."""
    m = ChangeManifest(
        hypothesis="h",
        target_cohort="c",
        changed_components=["x"],
        rollback_condition=RollbackCondition(metric="primary", threshold=">= -0.05"),
    )
    m.attach_observed(
        ObservedDeltas(primary_metric_delta=-0.10)  # worse than -0.05
    )
    assert m.should_rollback() is True


def test_change_manifest_rollback_condition_no_match() -> None:
    """should_rollback is False when the condition doesn't match."""
    m = ChangeManifest(
        hypothesis="h",
        target_cohort="c",
        changed_components=["x"],
        rollback_condition=RollbackCondition(metric="primary", threshold=">= -0.05"),
    )
    m.attach_observed(ObservedDeltas(primary_metric_delta=0.10))  # improvement
    assert m.should_rollback() is False


def test_experiment_manifest_yaml_round_trip() -> None:
    """ExperimentManifest YAML round-trips."""
    m = ExperimentManifest(
        id="exp-001",
        hypothesis="adaptive window > fixed window",
        component="context-compiler",
        baseline_version="v0.1.0",
        candidate_version="v0.2.0",
        cohorts=["tiny_bugfix", "refactor"],
        primary_metric="primary_score",
        secondary_metrics=["success_rate"],
        safety_guardrails=["security.workspace_escape"],
        cost_guardrails=["max_cost_delta_pct"],
        sample_plan=SamplePlan(
            cohorts=["tiny_bugfix", "refactor"], tasks_per_cohort=10, seeds_per_task=3
        ),
        stopping_rule=StoppingRule(kind="fixed", max_runs=60, min_runs=30),
        promotion_rule=PromotionRule(
            primary_cohort="tiny_bugfix",
            min_effect_size=0.3,
            noninferiority_margin=0.05,
            max_regression_cohorts=["security_sensitive"],
            security_guardrails=["security.workspace_escape"],
            cost_guardrails=["max_cost_delta_pct"],
        ),
        owner="research",
    )
    yaml_text = m.to_yaml()
    m2 = ExperimentManifest.from_yaml(yaml_text)
    assert m2.id == m.id
    assert m2.hypothesis == m.hypothesis
    assert m2.sample_plan is not None
    assert m2.sample_plan.total_runs == 60
    assert m2.promotion_rule is not None
    assert m2.promotion_rule.min_effect_size == 0.3


def test_sample_plan_total_runs() -> None:
    """SamplePlan.total_runs excludes holdouts."""
    sp = SamplePlan(
        cohorts=["c1", "c2", "c3"],
        tasks_per_cohort=10,
        seeds_per_task=3,
        holdout_cohorts=["c3"],
    )
    assert sp.total_runs == 2 * 10 * 3  # c1 + c2 only.


def test_sample_plan_rejects_invalid_counts() -> None:
    """SamplePlan rejects non-positive counts."""
    with pytest.raises(ValueError):
        SamplePlan(cohorts=["c"], tasks_per_cohort=0, seeds_per_task=1)
    with pytest.raises(ValueError):
        SamplePlan(cohorts=["c"], tasks_per_cohort=1, seeds_per_task=0)


def test_stopping_rule_rejects_invalid_alpha() -> None:
    """StoppingRule rejects alpha outside (0, 1)."""
    with pytest.raises(ValueError):
        StoppingRule(kind="fixed", max_runs=10, alpha=0.0)
    with pytest.raises(ValueError):
        StoppingRule(kind="fixed", max_runs=10, alpha=1.0)


def test_rollback_condition_threshold_parsing() -> None:
    """RollbackCondition threshold strings parse correctly."""
    rc = RollbackCondition(metric="x", threshold=">= 0.5")
    assert rc.matches({"x": 0.6}) is True
    assert rc.matches({"x": 0.4}) is False
    assert rc.matches({"x": 0.5}) is True  # >= is inclusive.
    assert rc.matches({"other": 0.9}) is False  # metric not present.


def test_rollback_condition_invalid_threshold_raises() -> None:
    """Invalid threshold format raises ValueError."""
    rc = RollbackCondition(metric="x", threshold="bad format")
    with pytest.raises(ValueError):
        rc.matches({"x": 0.5})

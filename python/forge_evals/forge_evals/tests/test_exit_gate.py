"""SPEC exit gate validation suite.

Verifies the 5 exit gate criteria (SPEC §18, §41, §50, ADR-0025):
1. Pinned runs reproduce for all baseline harnesses & capability differences are enforced.
2. Graders catch seeded faults (mutation test suite).
3. Costs and token accounting reconcile cleanly.
4. Multi-seed baseline variance and bootstrap confidence bounds are measured.
5. Promotion rules and rollbacks are machine-enforced.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from ..analysis.cost_analysis import find_anomalies, reconcile_costs
from ..analysis.seed_variance import compute_seed_variance
from ..baselines import validate_harness_task_compatibility
from ..graders.end_state import EndStateGraderInput, FileContainsGrader, WorkspaceSnapshot
from ..graders.mutation_tests import run_grader_mutation_suite
from ..hidden_test_guard import (
    CANARY_STRING,
    ContaminationChecker,
    HiddenTestIsolationGuard,
    LeakageViolationError,
)
from ..promotion_gate import (
    Evaluation,
    PromotionDecision,
    evaluate_promotion,
)
from ..run_record import CostBreakdown, Outcome, RunRecord
from ..runners import (
    Budgets,
    HarnessRunner,
    ModelCapabilitySnapshot,
    RunRequest,
    get_baseline_harness,
)


def test_exit_gate_1_pinned_runs_reproduce_and_capability_compatibility(tmp_path: Path) -> None:
    """Exit Gate Condition 1: Pinned baseline runs execute cleanly and capabilities are enforced."""
    # Test all baseline harness adapters
    baseline_ids = ["forge_minimal", "forge_full", "upstream_opencode", "codex", "pi", "oh_my_pi", "claude_code", "mini_swe_agent"]
    
    task_dir = tmp_path / "task-001"
    task_dir.mkdir(parents=True, exist_ok=True)
    (task_dir / "task.yaml").write_text("source_commit: abc\nimage_digest: sha256:123\n", encoding="utf-8")

    model_snapshot = ModelCapabilitySnapshot(
        provider="fake",
        model="fake-1",
        api_version="v1",
        context_window=128000,
        max_output_tokens=4096,
        supports_tool_calls=True,
        supports_streaming=True,
        supports_cache=True,
    )

    for b_id in baseline_ids:
        harness = get_baseline_harness(b_id)
        runner = HarnessRunner(harness=harness)
        request = RunRequest(
            suite="tiny-bugfix",
            task="fix-001",
            task_dir=task_dir,
            harness_id=b_id,
            harness_commit="pinned",
            model_snapshot=model_snapshot,
            random_seed=42,
            budgets=Budgets(),
        )
        record = runner.run(request)
        assert record.outcome == Outcome.COMPLETED, f"Baseline {b_id} failed: {record.notes}"
        assert record.harness == b_id
        assert record.environment_digest.startswith("sha256:")

    # Capability compatibility validation
    ok, reason = validate_harness_task_compatibility("forge_minimal", {"requires_mcp": True})
    assert not ok
    assert "does not support MCP" in reason

    ok, reason = validate_harness_task_compatibility("forge_full", {"requires_mcp": True})
    assert ok


def test_exit_gate_2_graders_catch_seeded_faults(tmp_path: Path) -> None:
    """Exit Gate Condition 2: Graders catch 100% of seeded mutation faults."""
    grader = FileContainsGrader(
        path="solution.py",
        required_substrings=["def target_fn():", "return 42"],
        forbidden_substrings=["_MUTATED_FLAG", "invalid_attribute_dereference"],
    )
    base_input = EndStateGraderInput(
        snapshot=WorkspaceSnapshot(
            workdir=tmp_path, final_revision="deadbeef", baseline_revision="head"
        ),
        objective="Ensure target_fn implementation exists",
        acceptance_criteria=[],
    )
    sample_code = "def target_fn():\n    return 42\n"
    report = run_grader_mutation_suite(grader, base_input, sample_code, target_file="solution.py")
    assert report.total_mutants > 0
    assert report.caught_mutants == report.total_mutants
    assert report.passed


def test_exit_gate_3_cost_and_token_bill_reconciliation() -> None:
    """Exit Gate Condition 3: Token usage and provider costs reconcile cleanly."""
    valid_cost = CostBreakdown(
        provider_reported_usd=0.0105,
        computed_usd=0.0105,
        input_tokens=1000,
        output_tokens=500,
    )
    r1 = RunRecord.new(
        suite="tiny-bugfix",
        task="t-1",
        harness="forge_full",
        harness_commit="v1",
        environment_digest="sha256:123",
        random_seed=42,
    )
    r1.cost = valid_cost
    rec1 = reconcile_costs([r1])
    assert not rec1[0].flagged

    anomalous_cost = CostBreakdown(
        provider_reported_usd=1.5000,
        computed_usd=0.0105,
        input_tokens=1000,
        output_tokens=500,
    )
    r2 = RunRecord.new(
        suite="tiny-bugfix",
        task="t-2",
        harness="forge_full",
        harness_commit="v1",
        environment_digest="sha256:123",
        random_seed=42,
    )
    r2.cost = anomalous_cost
    anomalies = find_anomalies([r2])
    assert len(anomalies) == 1
    assert anomalies[0].severity == "high"


def test_exit_gate_4_multi_seed_baseline_variance_measured() -> None:
    """Exit Gate Condition 4: Multi-seed baseline variance and confidence bounds are measured."""
    records = []
    for seed, score in zip([1, 2, 3, 4, 5], [0.8, 0.85, 0.9, 0.82, 0.88], strict=True):
        r = RunRecord.new(
            suite="tiny-bugfix",
            task="t-1",
            harness="forge_full",
            harness_commit="v1",
            environment_digest="sha256:123",
            random_seed=seed,
        )
        r.outcome = Outcome.COMPLETED
        r.notes = f"score={score}"
        records.append(r)

    variance_results = compute_seed_variance(records)
    assert len(variance_results) == 1
    res = variance_results[0]
    assert res.n_runs == 5
    assert res.score_ci_low <= res.mean_score <= res.score_ci_high


def test_exit_gate_5_machine_enforced_promotion_and_rollback() -> None:
    """Exit Gate Condition 5: Promotion rules and rollbacks are machine-enforced."""
    # Security violation -> Machine-enforced ROLLBACK
    ev_security_fail = Evaluation(
        primary_cohort="tiny-bugfix",
        primary_metric_delta=0.15,
        primary_ci_low=0.05,
        primary_ci_high=0.25,
        primary_effect_size=0.8,
        primary_effect_size_ci_low=0.2,
        primary_effect_size_ci_high=1.4,
        min_effect_size=0.3,
        security_guardrails={"workspace_escape": False},
        security_guardrail_failed=True,
    )
    res_security = evaluate_promotion(ev_security_fail)
    assert res_security.decision == PromotionDecision.ROLLBACK
    assert not res_security.passed
    assert "security_guardrails" in res_security.blocking_gates

    # Unacceptable regression -> Machine-enforced REVISE
    ev_regression = Evaluation(
        primary_cohort="tiny-bugfix",
        primary_metric_delta=0.15,
        primary_ci_low=0.05,
        primary_ci_high=0.25,
        primary_effect_size=0.8,
        primary_effect_size_ci_low=0.2,
        primary_effect_size_ci_high=1.4,
        min_effect_size=0.3,
        regression_cohorts=["security-sensitive"],
    )
    res_reg = evaluate_promotion(ev_regression)
    assert res_reg.decision == PromotionDecision.REVISE
    assert not res_reg.passed

    # Clean pass -> PROMOTE
    ev_pass = Evaluation(
        primary_cohort="tiny-bugfix",
        primary_metric_delta=0.15,
        primary_ci_low=0.05,
        primary_ci_high=0.25,
        primary_effect_size=0.8,
        primary_effect_size_ci_low=0.2,
        primary_effect_size_ci_high=1.4,
        min_effect_size=0.3,
        security_guardrails={"workspace_escape": True},
    )
    res_pass = evaluate_promotion(ev_pass)
    assert res_pass.decision == PromotionDecision.PROMOTE
    assert res_pass.passed


def test_hidden_test_guard_and_leakage_controls(tmp_path: Path) -> None:
    """Verify hidden-test isolation guard and leakage controls."""
    assert HiddenTestIsolationGuard.is_hidden_path("evals/tasks/tiny-bugfix/01/hidden/test_secret.py")
    assert not HiddenTestIsolationGuard.is_hidden_path("evals/tasks/tiny-bugfix/01/main.py")

    manifest = {"fragments": [{"source_path": "evals/tasks/tiny-bugfix/01/hidden/test_secret.py"}]}
    with pytest.raises(LeakageViolationError):
        HiddenTestIsolationGuard.validate_context_manifest(manifest)

    prompt = f"Here is canary {CANARY_STRING}"
    violations = ContaminationChecker.check_prompt_leakage(prompt, tmp_path)
    assert len(violations) > 0

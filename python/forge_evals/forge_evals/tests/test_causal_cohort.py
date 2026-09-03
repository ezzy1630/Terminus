"""Cohort metrics, holdout partitions, and the causal comparison tests."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from forge_evals.cohort_compare import compare_cohort_runs
from forge_evals.cohort_metrics import cohort_metrics, percentile
from forge_evals.evidence import EvidenceClass
from forge_evals.holdout import (
    Partition,
    PartitionError,
    PartitionRegistry,
    PartitionRule,
    load_partition_registry,
)
from forge_evals.identity import EvaluationIdentity
from forge_evals.promotion_gate import (
    PromotionDecision,
    ReliabilityEvidence,
    evaluate_paired_promotion,
    evaluate_promotion,
)
from forge_evals.run_record import CostBreakdown, GraderResult, Outcome, RunRecord


def _identity(harness: str, seed: int, task: str = "t") -> EvaluationIdentity:
    return EvaluationIdentity(
        task_id=task,
        task_version="v",
        repository_digest="sha256:r",
        environment_digest="sha256:e",
        harness_id=harness,
        harness_commit=f"commit:{harness}",
        harness_config_hash=f"cfg:{harness}",
        provider="p",
        model="model-v1",
        model_version="mv",
        model_capability_snapshot_hash="sha256:cap",
        random_seed=seed,
        sampling_config_hash="sha256:s",
        sandbox_policy_hash="sha256:sp",
        network_policy="proxy",
        budget_hash="sha256:b",
        tool_schema_hash="sha256:t",
        instruction_hash="sha256:i",
        provider_endpoint_hash="sha256:" + "e" * 64,
        provider_account_hash="sha256:" + "a" * 64,
    )


def _record(
    suite: str,
    task: str,
    seed: int,
    harness: str,
    *,
    passed: bool = True,
    admitted: bool = True,
    outcome: Outcome = Outcome.COMPLETED,
    attempts: list[dict[str, Any]] | None = None,
    cost: float | None = 0.10,
    wall_ms: int | None = 30_000,
    steps: int = 5,
    holdout: str | None = None,
) -> RunRecord:
    record = RunRecord.new(
        suite=suite,
        task=task,
        harness=harness,
        harness_commit=f"commit:{harness}",
        environment_digest="sha256:" + "e" * 64,
        random_seed=seed,
        evidence_class=EvidenceClass.EXTERNAL_LIVE,
        holdout_partition=holdout,
        evaluation_identity=_identity(harness, seed),
    )
    record.outcome = outcome
    record.grader_results = [
        GraderResult(
            grader_id="g",
            grader_version="1",
            passed=passed,
            score=1.0 if passed else 0.0,
        )
    ]
    record.harness_verdict = {
        "admitted": admitted,
        "status": "admitted" if admitted else "verification_failed",
    }
    if cost is not None:
        record.cost = CostBreakdown(
            provider_reported_usd=cost, computed_usd=cost, input_tokens=1_000, output_tokens=500
        )
    record.wall_clock_ms = wall_ms
    record.steps = steps
    record.tokens_input_fresh = 800
    record.tokens_input_cached = 200
    record.tokens_output = 500
    record.tokens_reasoning = 100
    if attempts:
        record.attempts = attempts
    return record


# ───────────────────────────── cohort_metrics ─────────────────────────────


def test_percentile_interpolates() -> None:
    assert percentile([1.0, 2.0, 3.0, 4.0], 50) == 2.5
    assert percentile([5.0], 95) == 5.0
    assert percentile([1.0, 2.0, 3.0, 4.0], 100) == 4.0
    assert percentile([], 50) != percentile([], 50)  # NaN


def test_cohort_metrics_full_record() -> None:
    attempts = [
        {"cached_input_tokens": 0},
        {"cached_input_tokens": 900},
        {"cached_input_tokens": 1000},
    ]
    runs = [_record("canary", f"t{i}", i, "terminus-live", attempts=attempts) for i in range(3)]
    metrics = cohort_metrics(runs, slice_name="canary/all")
    assert metrics.runs == 3
    cells = metrics.cells
    assert cells["resolved_task_rate"].value == 1.0
    assert cells["false_completion_rate"].value == 0.0
    assert cells["stuck_state_rate"].value == 0.0
    assert cells["cost_per_resolved_task_usd"].value == pytest.approx(0.10)
    assert cells["tool_calls_per_resolved_task"].value == 5.0
    assert cells["cache_prefix_survival"].value == 1.0
    assert cells["provider_retries_per_run"].value == 2.0
    # Token breakdowns are reported.
    assert cells["tokens_input_cached"].value == 200.0
    assert cells["tokens_output"].value == 500.0
    assert cells["tokens_reasoning"].value == 100.0
    # CIs are attached to rate metrics.
    assert cells["resolved_task_rate"].ci_low is not None


def test_cohort_metrics_reads_canonical_manifest_tokens_and_cache_observations() -> None:
    record = _record("canary", "task", 1, "candidate", passed=True)
    record.context_manifests = [
        {
            "estimated_tokens": {"predictedInput": 700},
            "cache_plan": {"stablePrefixHash": "sha256:same"},
            "experiment": {"observation": {"cache": {"observedCachedTokens": 0}}},
        },
        {
            "estimated_tokens": {"predictedInput": 900},
            "cache_plan": {"stablePrefixHash": "sha256:same"},
            "experiment": {"observation": {"cache": {"observedCachedTokens": 650}}},
        },
        {
            "estimated_tokens": {"predictedInput": 600},
            "cache_plan": {"stablePrefixHash": "sha256:same"},
            "experiment": {"observation": {"cache": {"observedCachedTokens": 0}}},
        },
    ]

    cells = cohort_metrics([record], slice_name="canonical").cells

    assert cells["context_selected_tokens"].value == 2200
    assert cells["cache_prefix_survival"].value == 0.5


def test_cohort_metrics_detects_false_completion_and_false_block() -> None:
    runs = [
        _record("canary", "t1", 1, "terminus-live", passed=True, admitted=False),
        _record("canary", "t2", 2, "terminus-live", passed=False, admitted=True),
        _record("canary", "t3", 3, "terminus-live"),
    ]
    metrics = cohort_metrics(runs, slice_name="canary/all")
    # t1: verification blocked a grader-passing workspace.
    assert metrics.cells["verification_false_block_rate"].value == pytest.approx(1 / 3)
    # t2: the harness admitted a completion the graders rejected.
    assert metrics.cells["false_completion_rate"].value == pytest.approx(1 / 3)


def test_cohort_metrics_unmeasured_stays_none() -> None:
    record = _record("canary", "t1", 1, "terminus-live", cost=None, wall_ms=None, steps=0)
    metrics = cohort_metrics([record], slice_name="solo")
    assert metrics.cells["cost_per_run_usd"].value is None
    assert metrics.cells["cost_per_run_usd"].note == "not measured on any run"
    assert metrics.cells["latency_ms_median"].value is None
    assert metrics.cells["cache_prefix_survival"].value is None


# ─────────────────────────────── holdout ──────────────────────────────────


def test_registry_loads_and_enforces() -> None:
    registry = load_partition_registry()
    assert registry.partition_for("canary", "diag-001") is Partition.DEV
    assert registry.partition_for("build-failure", "build-001") is Partition.HOLDOUT
    assert (
        registry.partition_for("malicious-repository-instructions", "mri-001") is Partition.BLOCKED
    )
    # Unlisted cells default to dev.
    assert registry.partition_for("some-new-suite", "task-x") is Partition.DEV


def test_registry_missing_file_fails_closed(tmp_path: Path) -> None:
    with pytest.raises(PartitionError):
        load_partition_registry(tmp_path / "absent.yaml")


def test_enforcement_flags_blocked_and_unstamped_holdout() -> None:
    registry = PartitionRegistry(
        [
            PartitionRule(
                suite="blocked-suite", cohort=None, task=None, partition=Partition.BLOCKED
            ),
            PartitionRule(suite="hold-suite", cohort=None, task="h-1", partition=Partition.HOLDOUT),
        ]
    )
    issues = registry.enforcement_issues(
        [
            _record("blocked-suite", "b1", 1, "h"),
            _record("hold-suite", "h-1", 1, "h", holdout=None),
            _record("hold-suite", "h-1", 1, "h", holdout="holdout"),
        ]
    )
    assert len(issues) == 2
    assert any("blocked cell" in issue for issue in issues)
    assert any("not stamped" in issue for issue in issues)


# ───────────────────────────── cohort_compare ─────────────────────────────


def _paired_runs(harness_commits: tuple[str, str]) -> tuple[list[RunRecord], list[RunRecord]]:
    baseline = []
    candidate = []
    for suite in ("canary",):
        for i in range(6):
            seed = 40 + i
            baseline.append(_record(suite, f"task-{i}", seed, harness_commits[0], passed=True))
            # Candidate resolves 4/6 with two false completions; baseline 6/6.
            candidate.append(
                _record(
                    suite,
                    f"task-{i}",
                    seed,
                    harness_commits[1],
                    passed=i < 4,
                    admitted=i >= 4,
                )
            )
    return baseline, candidate


def test_compare_cohort_runs_pairs_and_reliability_gates(tmp_path: Path) -> None:
    baseline, candidate = _paired_runs(("a" * 40, "b" * 40))
    comparison = compare_cohort_runs(baseline, candidate, output_dir=tmp_path)
    assert comparison.pair_count == 6
    assert comparison.slices[0].pairs == 6
    assert comparison.slices[0].resolved_delta == pytest.approx(-2 / 6)
    # Six cells are too few for the bootstrap CI to exclude zero — the
    # verdict honestly reports no_change instead of reacting to one run.
    # The reliability gates are where this candidate definitively fails.
    assert comparison.slices[0].verdict == "no_change"
    # The candidate admitted two completions the graders rejected.
    gates = comparison.reliability_gates
    assert gates["false_completion"]["status"] == "fail"
    assert comparison.eligible is True
    # Artifacts written.
    assert (tmp_path / "cohort-comparison.json").is_file()
    assert (tmp_path / "cohort-comparison.md").is_file()
    summary = (tmp_path / "cohort-comparison.md").read_text(encoding="utf-8")
    assert "NOT ELIGIBLE" not in summary
    assert "Reliability gates" in summary


def test_compare_cohort_runs_unpaired_cells_are_issues(tmp_path: Path) -> None:
    baseline, candidate = _paired_runs(("a" * 40, "b" * 40))
    comparison = compare_cohort_runs(baseline, candidate[:-1], output_dir=None)
    assert comparison.pair_count == 5
    assert comparison.eligible is False
    assert any("baseline cells without a candidate match" in issue for issue in comparison.issues)


def test_compare_cohort_runs_blocked_partition_fails_closed(tmp_path: Path) -> None:
    baseline, candidate = _paired_runs(("a" * 40, "b" * 40))
    registry = PartitionRegistry(
        [PartitionRule(suite="canary", cohort=None, task=None, partition=Partition.BLOCKED)]
    )
    comparison = compare_cohort_runs(baseline, candidate, registry=registry, output_dir=None)
    assert comparison.eligible is False
    assert any("blocked cell" in issue for issue in comparison.issues)


def test_compare_cohort_runs_holdout_requires_stamping(tmp_path: Path) -> None:
    baseline, candidate = _paired_runs(("a" * 40, "b" * 40))
    registry = PartitionRegistry(
        [PartitionRule(suite="canary", cohort=None, task=None, partition=Partition.HOLDOUT)]
    )
    comparison = compare_cohort_runs(baseline, candidate, registry=registry, output_dir=None)
    assert comparison.eligible is False
    stamped_baseline = list(baseline)
    for record in stamped_baseline + candidate:
        record.holdout_partition = "holdout"
    ok = compare_cohort_runs(stamped_baseline, candidate, registry=registry, output_dir=None)
    assert ok.eligible is True


def test_compare_cohort_runs_report_is_json_serializable(tmp_path: Path) -> None:
    baseline, candidate = _paired_runs(("a" * 40, "b" * 40))
    comparison = compare_cohort_runs(baseline, candidate, output_dir=None)
    encoded = json.dumps(comparison.to_dict(), sort_keys=True)
    assert "terminus.cohort.comparison/v1" in encoded


# ─────────────────────── promotion gate: reliability ───────────────────────


def test_reliability_breaches_reject_candidate() -> None:
    """Breached reliability margins name the failing check; clean ones pass."""
    evidence = ReliabilityEvidence(
        false_completion_baseline=0.0,
        false_completion_candidate=0.33,
        stuck_state_baseline=0.0,
        stuck_state_candidate=0.0,
    )
    assert any("false_completion" in b for b in evidence.breaches())

    clean = ReliabilityEvidence(
        false_completion_baseline=0.1,
        false_completion_candidate=0.11,
        stuck_state_baseline=0.0,
        stuck_state_candidate=0.0,
        verification_false_block_baseline=0.05,
        verification_false_block_candidate=0.04,
        cache_prefix_survival_baseline=0.8,
        cache_prefix_survival_candidate=0.82,
    )
    assert clean.breaches() == []


def test_promotion_gate_fails_on_reliability_regression() -> None:
    from forge_evals.promotion_gate import Evaluation

    evaluation = Evaluation(
        primary_cohort="canary",
        primary_metric_delta=0.10,
        primary_ci_low=0.05,
        primary_ci_high=0.15,
        primary_effect_size=0.6,
        primary_effect_size_ci_low=0.2,
        primary_effect_size_ci_high=1.0,
        min_effect_size=0.3,
        pareto_improves=True,
        reliability=ReliabilityEvidence(
            false_completion_baseline=0.0,
            false_completion_candidate=0.2,
        ),
    )
    result = evaluate_promotion(evaluation)
    assert result.decision is PromotionDecision.REVISE
    reliability_gate = next((g for g in result.gates if g.name == "reliability"), None)
    assert reliability_gate is not None
    assert reliability_gate.status.value == "fail"


def test_promotion_gate_silent_without_reliability_evidence() -> None:
    from forge_evals.promotion_gate import Evaluation

    evaluation = Evaluation(
        primary_cohort="canary",
        primary_metric_delta=0.10,
        primary_ci_low=0.05,
        primary_ci_high=0.15,
        primary_effect_size=0.6,
        primary_effect_size_ci_low=0.2,
        primary_effect_size_ci_high=1.0,
        min_effect_size=0.3,
        pareto_improves=True,
        reliability=None,
    )
    result = evaluate_promotion(evaluation)
    reliability_gate = next((g for g in result.gates if g.name == "reliability"), None)
    assert reliability_gate is not None
    assert reliability_gate.status.value == "n/a"


def test_evaluate_paired_promotion_accepts_reliability() -> None:
    """The paired entry point threads reliability evidence through."""
    from forge_evals.paired_evaluation import PairedOutcome, derive_paired_evidence

    outcomes = [
        PairedOutcome(suite="s", task=f"t{i}", seed=40, baseline_passed=True, candidate_passed=True)
        for i in range(6)
    ]

    baseline_records = []
    candidate_records = []

    for outcome in outcomes:
        base = RunRecord.new(
            suite=outcome.suite,
            task=outcome.task,
            harness="base",
            harness_commit="c:base",
            environment_digest="sha256:e",
            random_seed=outcome.seed,
            evaluation_identity=_identity("base", outcome.seed, task=outcome.task),
            evidence_class=EvidenceClass.EXTERNAL_LIVE,
            holdout_partition="holdout",
            independently_verified=True,
        )
        cand = RunRecord.new(
            suite=outcome.suite,
            task=outcome.task,
            harness="cand",
            harness_commit="c:cand",
            environment_digest="sha256:e",
            random_seed=outcome.seed,
            evaluation_identity=_identity("cand", outcome.seed, task=outcome.task),
            evidence_class=EvidenceClass.EXTERNAL_LIVE,
            holdout_partition="holdout",
            independently_verified=True,
        )
        for record, _passed in ((base, True), (cand, True)):
            record.outcome = Outcome.COMPLETED
            record.grader_results = [
                GraderResult(grader_id="g", grader_version="1", passed=True, score=1.0)
            ]
        base.end = base.start
        cand.end = cand.start
        baseline_records.append(base)
        candidate_records.append(cand)

    evidence = derive_paired_evidence(
        baseline_records,
        candidate_records,
        metric="passed",
        required_holdout_partition="holdout",
        required_tasks={f"t{i}" for i in range(6)},
        required_seeds={40},
    )
    result = evaluate_paired_promotion(
        evidence,
        min_effect_size=0.0,
        security_guardrails={"a": True},
        pareto_improves=True,
        reliability=ReliabilityEvidence(
            false_completion_baseline=0.0,
            false_completion_candidate=0.5,
        ),
        require_live=False,
        require_independent_verification=False,
        require_holdout=False,
        require_provider_receipts=False,
        require_complete_cohort=False,
    )
    reliability_gate = next((g for g in result.gates if g.name == "reliability"), None)
    assert reliability_gate is not None
    assert reliability_gate.status.value == "fail"

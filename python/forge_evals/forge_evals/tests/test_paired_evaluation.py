"""Model-fixed identity and paired promotion evidence tests."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pytest

from forge_evals.analysis.load_runs import load_runs_from_parquet
from forge_evals.evidence import EvidenceClass
from forge_evals.identity import EvaluationIdentity
from forge_evals.paired_evaluation import derive_paired_evidence
from forge_evals.promotion_gate import PromotionDecision, evaluate_paired_promotion
from forge_evals.run_record import CostBreakdown, GraderResult, Outcome, RunRecord
from forge_evals.statistics.bootstrap import bootstrap_ci


def _identity(task: str, seed: int, harness: str) -> EvaluationIdentity:
    return EvaluationIdentity(
        task_id=task,
        task_version="task-v1",
        repository_digest="sha256:repo",
        environment_digest="sha256:env",
        harness_id=harness,
        harness_commit=f"commit:{harness}",
        harness_config_hash=f"config:{harness}",
        provider="provider",
        model="model-v1",
        model_version="model-version-1",
        model_capability_snapshot_hash="sha256:capabilities",
        random_seed=seed,
        sampling_config_hash="sha256:sampling",
        sandbox_policy_hash="sha256:sandbox",
        network_policy="proxy-only",
        budget_hash="sha256:budget",
        tool_schema_hash="sha256:tools",
        instruction_hash="sha256:instructions",
        provider_endpoint_hash="sha256:" + "e" * 64,
        provider_account_hash="sha256:" + "a" * 64,
    )


def _record(task: str, seed: int, harness: str, passed: bool) -> RunRecord:
    record = RunRecord.new(
        suite="tiny_bugfix",
        task=task,
        harness=harness,
        harness_commit=f"commit:{harness}",
        environment_digest="sha256:env",
        random_seed=seed,
        evaluation_identity=_identity(task, seed, harness),
        evidence_class=EvidenceClass.EXTERNAL_LIVE,
        holdout_partition="final_release_holdout",
        independently_verified=True,
        provider_receipts=[
            {
                "receipt_id": f"receipt-{harness}-{task}-{seed}",
                "receipt_kind": "provider",
                "provider": "provider",
                "model": "model-v1",
                "request_id": f"request-{harness}-{task}-{seed}",
                "endpoint_hash": "sha256:" + "e" * 64,
                "account_hash": "sha256:" + "a" * 64,
                "artifact_ref": f"artifact://sha256/{seed:064x}",
                "response_artifact_ref": f"artifact://sha256/{seed:064x}",
                "usage": {"input": 100, "output": 50},
                "verified": True,
            }
        ],
    )
    record.outcome = Outcome.COMPLETED if passed else Outcome.FAILED
    record.grader_results = [
        GraderResult(
            grader_id="end_state",
            grader_version="v1",
            passed=passed,
            score=1.0 if passed else 0.0,
        )
    ]
    record.cost = CostBreakdown(
        provider_reported_usd=0.01,
        computed_usd=0.01,
        input_tokens=100,
        output_tokens=50,
    )
    record.end = record.start
    return record


def test_identity_hash_excludes_harness_identity_for_model_fixed_pairs() -> None:
    baseline = _identity("task-1", 7, "baseline")
    candidate = _identity("task-1", 7, "candidate")

    assert baseline.result_key != candidate.result_key
    assert baseline.model_fixed_key == candidate.model_fixed_key
    assert baseline.compatible_model_fixed(candidate)


def test_locked_identity_survives_json_round_trip(tmp_path: Path) -> None:
    record = _record("task-1", 7, "baseline", True)

    loaded = RunRecord.from_json(record.to_json(tmp_path / "record.json"))

    assert loaded.evaluation_identity == record.evaluation_identity


def test_locked_identity_survives_parquet_loader_round_trip(tmp_path: Path) -> None:
    record = _record("task-1", 7, "baseline", True)

    loaded = load_runs_from_parquet(record.to_parquet(tmp_path / "record.parquet"))

    assert loaded.records[0].evaluation_identity == record.evaluation_identity
    assert "evaluation_identity" in loaded.df.columns


def test_derive_paired_evidence_requires_exact_locked_identity() -> None:
    baseline = [_record("task-1", 7, "baseline", False)]
    candidate = [_record("task-1", 7, "candidate", True)]
    evidence = derive_paired_evidence(baseline, candidate, min_pairs=2)

    assert evidence.n == 1
    assert not evidence.eligible
    assert not evidence.issues


def test_derive_paired_evidence_rejects_runner_identity_with_missing_policy_fields() -> None:
    baseline = _record("task-1", 7, "baseline", False)
    candidate = _record("task-1", 7, "candidate", True)
    assert baseline.evaluation_identity is not None
    baseline.evaluation_identity = replace(
        baseline.evaluation_identity,
        sandbox_policy_hash="missing:sandbox_policy_hash",
    )
    evidence = derive_paired_evidence(baseline_records=[baseline], candidate_records=[candidate])

    assert not evidence.eligible
    assert evidence.n == 0
    assert any("complete task, policy" in issue.reason for issue in evidence.issues)


def test_derive_paired_evidence_calculates_token_independent_paired_statistics() -> None:
    baseline = [_record(f"task-{i}", i, "baseline", False) for i in range(3)]
    candidate = [_record(f"task-{i}", i, "candidate", True) for i in range(3)]
    evidence = derive_paired_evidence(
        baseline,
        candidate,
        min_pairs=3,
        noninferiority_margin=0.05,
        n_bootstrap=100,
    )

    assert evidence.eligible
    assert evidence.identity_locked
    assert evidence.n == 3
    assert len(evidence.identity_bindings) == evidence.n
    assert evidence.identity_bindings[0].model_fixed_key.startswith("sha256:")
    assert evidence.mean_delta == 1.0
    assert evidence.ci_low == 1.0
    assert evidence.effect_size > 0
    assert evidence.noninferiority is not None
    assert evidence.noninferiority.is_noninferior


def test_paired_promotion_does_not_promote_without_operational_evidence() -> None:
    baseline = [_record(f"task-{i}", i, "baseline", False) for i in range(3)]
    candidate = [_record(f"task-{i}", i, "candidate", True) for i in range(3)]
    evidence = derive_paired_evidence(
        baseline,
        candidate,
        min_pairs=3,
        n_bootstrap=100,
        require_live=True,
        require_independent_verification=True,
        required_holdout_partition="final_release_holdout",
        required_tasks={f"task-{i}" for i in range(3)},
        required_seeds={0, 1, 2},
        require_provider_receipts=True,
    )

    result = evaluate_paired_promotion(
        evidence,
        min_effect_size=0.3,
        security_guardrails={"workspace_escape": True},
    )
    assert result.decision is not PromotionDecision.PROMOTE


def test_paired_promotion_requires_explicit_operational_and_frontier_claims() -> None:
    baseline = [
        _record(f"task-{i}", seed, "baseline", False) for i in range(3) for seed in range(3)
    ]
    candidate = [
        _record(f"task-{i}", seed, "candidate", True) for i in range(3) for seed in range(3)
    ]
    evidence = derive_paired_evidence(
        baseline,
        candidate,
        min_pairs=9,
        n_bootstrap=100,
        require_live=True,
        require_independent_verification=True,
        required_holdout_partition="final_release_holdout",
        required_tasks={f"task-{i}" for i in range(3)},
        required_seeds={0, 1, 2},
        require_provider_receipts=True,
    )

    result = evaluate_paired_promotion(
        evidence,
        min_effect_size=0.3,
        security_guardrails={"workspace_escape": True},
        pareto_improves=True,
        has_observability=True,
        has_rollback=True,
        has_documentation=True,
        has_migration_behavior=True,
        maintainability_within_budget=True,
        divergence_within_budget=True,
        require_live=True,
        require_independent_verification=True,
        require_holdout=True,
        require_provider_receipts=True,
        require_complete_cohort=True,
    )
    assert result.decision is PromotionDecision.PROMOTE


def test_exact_pass_fail_outcomes_are_keyed_by_suite_task_and_seed() -> None:
    """The primary benchmark outcome is the independent grader verdict."""
    baseline = [_record("task-1", seed, "baseline", False) for seed in (2, 1)]
    candidate = [_record("task-1", seed, "candidate", True) for seed in (1, 2)]

    evidence = derive_paired_evidence(baseline, candidate, min_pairs=2, n_bootstrap=32)

    assert [outcome.key for outcome in evidence.outcomes] == [
        ("tiny_bugfix", "task-1", 1),
        ("tiny_bugfix", "task-1", 2),
    ]
    assert [outcome.baseline_passed for outcome in evidence.exact_pairs] == [False, False]
    assert [outcome.candidate_passed for outcome in evidence.exact_pairs] == [True, True]
    assert evidence.mcnemar.n == 2
    assert evidence.mcnemar.discordant == 2
    assert evidence.to_dict()["outcomes"] == [outcome.to_dict() for outcome in evidence.outcomes]


def test_paired_success_does_not_erase_a_passing_patch_after_harness_failure() -> None:
    """Lifecycle failure is secondary; the hidden grader still owns task success."""
    baseline = _record("task-1", 1, "baseline", False)
    candidate = _record("task-1", 1, "candidate", True)
    candidate.outcome = Outcome.FAILED

    evidence = derive_paired_evidence([baseline], [candidate], min_pairs=1, n_bootstrap=32)

    assert candidate.success is True
    assert candidate.passed is False
    assert evidence.outcomes[0].candidate_passed is True
    assert evidence.pairs[0].candidate == 1.0


def test_repeated_seeds_use_task_cluster_bootstrap_for_uncertainty() -> None:
    """Repeated seeds must not be counted as independent task clusters."""
    baseline = []
    candidate = []
    for task, baseline_passed, candidate_passed in (
        ("task-a", False, True),
        ("task-b", False, False),
        ("task-c", False, False),
    ):
        for seed in (1, 2):
            baseline.append(_record(task, seed, "baseline", baseline_passed))
            candidate.append(_record(task, seed, "candidate", candidate_passed))

    evidence = derive_paired_evidence(
        baseline,
        candidate,
        min_pairs=6,
        n_bootstrap=256,
        rng_seed=23,
        practical_improvement_threshold=0.25,
    )
    expected_cluster_ci = bootstrap_ci(
        [1.0, 0.0, 0.0],
        lambda sample: sum(sample) / len(sample) if sample else 0.0,
        n_resamples=256,
        rng_seed=23,
    )

    assert evidence.n == 6
    assert evidence.cluster_count == 3
    assert evidence.uncertainty_unit == "task"
    assert evidence.pair_mean_delta == pytest.approx(1 / 3)
    assert evidence.cluster_mean_delta == pytest.approx(1 / 3)
    assert evidence.cluster_ci_low == pytest.approx(expected_cluster_ci[0])
    assert evidence.cluster_ci_high == pytest.approx(expected_cluster_ci[1])
    assert evidence.ci_low == evidence.cluster_ci_low
    assert evidence.ci_high == evidence.cluster_ci_high


def test_holm_alpha_and_practical_threshold_form_a_separate_significance_gate() -> None:
    """Holm correction and a meaningful delta are both required for the gate."""
    baseline = [_record(f"task-{index}", 1, "baseline", False) for index in range(30)]
    candidate = [_record(f"task-{index}", 1, "candidate", True) for index in range(30)]

    evidence = derive_paired_evidence(
        baseline,
        candidate,
        min_pairs=30,
        n_bootstrap=64,
        alpha=0.01,
        holm_family_size=5,
        practical_improvement_threshold=0.9,
    )

    assert evidence.alpha == 0.01
    assert evidence.holm_family_size == 5
    assert evidence.holm_adjusted_p_value >= evidence.mcnemar.p_value
    assert evidence.statistically_significant
    assert evidence.practically_significant
    assert evidence.significance_passed
    assert evidence.benchmark_gate_passed

    too_high = derive_paired_evidence(
        baseline,
        candidate,
        min_pairs=30,
        n_bootstrap=64,
        practical_threshold=1.01,
    )
    assert too_high.statistically_significant
    assert not too_high.practically_significant
    assert not too_high.significance_passed


def test_significance_fields_do_not_bypass_provider_receipt_gate() -> None:
    """A significant result remains ineligible when receipt evidence is incomplete."""
    baseline = [_record(f"task-{index}", 1, "baseline", False) for index in range(30)]
    candidate = [_record(f"task-{index}", 1, "candidate", True) for index in range(30)]
    candidate[0].provider_receipts = []

    evidence = derive_paired_evidence(
        baseline,
        candidate,
        min_pairs=30,
        n_bootstrap=64,
        require_provider_receipts=True,
        practical_improvement_threshold=0.1,
    )

    assert evidence.statistically_significant
    assert evidence.practically_significant
    assert evidence.significance_passed
    assert not evidence.provider_receipts_complete
    assert not evidence.eligible
    assert any("provider receipts" in issue.reason for issue in evidence.issues)

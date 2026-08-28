"""Model-fixed identity and paired promotion evidence tests."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

from forge_evals.analysis.load_runs import load_runs_from_parquet
from forge_evals.evidence import EvidenceClass
from forge_evals.identity import EvaluationIdentity
from forge_evals.paired_evaluation import derive_paired_evidence
from forge_evals.promotion_gate import PromotionDecision, evaluate_paired_promotion
from forge_evals.run_record import CostBreakdown, GraderResult, Outcome, RunRecord


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
                "provider": "provider",
                "model": "model-v1",
                "artifact_ref": f"sha256:{seed:064x}",
                "verified": True,
            }
        ],
    )
    record.outcome = Outcome.COMPLETED if passed else Outcome.FAILED
    record.grader_results = [GraderResult(
        grader_id="end_state",
        grader_version="v1",
        passed=passed,
        score=1.0 if passed else 0.0,
    )]
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
    baseline = [_record(f"task-{i}", seed, "baseline", False) for i in range(3) for seed in range(3)]
    candidate = [_record(f"task-{i}", seed, "candidate", True) for i in range(3) for seed in range(3)]
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

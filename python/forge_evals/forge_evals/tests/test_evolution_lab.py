"""Phase 11 sealed Evolution Lab contract tests."""

from __future__ import annotations

import hashlib
from dataclasses import replace

import pytest

from forge_evals.evolution_lab import (
    CanaryDecision,
    CanaryObservation,
    CandidateLifecycle,
    CandidateStage,
    CausalAblationPlan,
    CoevolutionExperiment,
    EvaluationActor,
    EvaluationPartition,
    EvaluationReceipt,
    EvolutionCandidate,
    FailureAttribution,
    ParetoArchive,
    ParetoPoint,
    PartitionAccessError,
    PromotionSignature,
    RepairMemory,
    RepairMemoryEntry,
    assert_partition_access,
)

COMMIT = "a" * 40
CONFIGURATION = f"sha256:{'c' * 64}"


def _candidate() -> EvolutionCandidate:
    changed_components = ("context-ranking",)
    return EvolutionCandidate(
        candidate_id="candidate-001",
        experiment_id="experiment-001",
        source_commit=COMMIT,
        platform="linux-x86_64",
        baseline_version="git:base",
        candidate_version="git:candidate",
        configuration_identity=CONFIGURATION,
        attribution=FailureAttribution(
            attribution_id="attribution-017",
            source_failure_ids=("failure-017",),
            trace_refs=(f"artifact://sha256/{'1' * 64}",),
            root_cause="retrieval omitted the changed interface contract",
            target_component="context-ranking",
            component_contributions={"context-ranking": 1.0},
        ),
        ablation_plan=CausalAblationPlan(
            changed_components=changed_components,
            cells=(frozenset(), frozenset(changed_components)),
            preregistration_ref=f"artifact://sha256/{'2' * 64}",
        ),
        source_failure_ids=("failure-017",),
        root_cause="retrieval omitted the changed interface contract",
        target_component="context-ranking",
        changed_components=changed_components,
        forbidden_components=("hidden-graders", "promotion-policy"),
        predicted_improvements={"verified_completion": 0.03},
        regression_floors={"security_success": 0.0, "cost": -0.05},
        predicted_cost_delta_pct=2.0,
        predicted_latency_delta_pct=1.0,
        security_effect="no authority or trust-boundary change",
        privacy_effect="no new data leaves the task scope",
        required_tests=("context-ranking-unit", "focused-holdout"),
    )


def _receipt(
    stage: CandidateStage,
    *,
    passed: bool = True,
    partition: EvaluationPartition | None = None,
    cohorts: tuple[str, ...] = (),
    models: tuple[str, ...] = (),
    security_guardrails: dict[str, bool] | None = None,
) -> EvaluationReceipt:
    digest = hashlib.sha256(stage.value.encode()).hexdigest()
    return EvaluationReceipt(
        candidate_id="candidate-001",
        candidate_version="git:candidate",
        experiment_id="experiment-001",
        source_commit=COMMIT,
        platform="linux-x86_64",
        evaluator_principal="isolated-evaluator",
        run_manifest_ref=f"artifact://sha256/{'f' * 64}",
        configuration_identity=CONFIGURATION,
        resolved_configuration_identity=CONFIGURATION,
        stage=stage,
        artifact_ref=f"artifact://sha256/{digest}",
        passed=passed,
        partition=partition,
        cohorts=cohorts,
        models=models,
        security_guardrails=security_guardrails or {},
    )


def _signature(lifecycle: CandidateLifecycle) -> PromotionSignature:
    return PromotionSignature(
        candidate_id=lifecycle.candidate.candidate_id,
        candidate_version=lifecycle.candidate.candidate_version,
        receipt_refs=tuple(receipt.artifact_ref for receipt in lifecycle.receipts),
        signer_principal="promotion-service",
        policy_hash=f"sha256:{'a' * 64}",
        signature_ref=f"artifact://sha256/{'b' * 64}",
    )


def _advance_to_security(lifecycle: CandidateLifecycle) -> None:
    lifecycle.record_receipt(_receipt(CandidateStage.STATIC), actor=EvaluationActor.EVALUATOR)
    lifecycle.record_receipt(_receipt(CandidateStage.SOURCE_FAILURE), actor=EvaluationActor.EVALUATOR)
    lifecycle.record_receipt(_receipt(CandidateStage.REPLAY), actor=EvaluationActor.EVALUATOR)
    lifecycle.record_receipt(
        _receipt(
            CandidateStage.FOCUSED_HOLDOUT,
            partition=EvaluationPartition.FOCUSED_HOLDOUT,
            cohorts=("bug-repair",),
            models=("model-a",),
        ),
        actor=EvaluationActor.EVALUATOR,
    )
    lifecycle.record_receipt(
        _receipt(
            CandidateStage.BROAD_HOLDOUT,
            partition=EvaluationPartition.BROAD_HOLDOUT,
            cohorts=("bug-repair", "cross-cutting-refactor"),
            models=("model-a", "model-b"),
        ),
        actor=EvaluationActor.EVALUATOR,
    )
    lifecycle.record_receipt(
        _receipt(
            CandidateStage.SECURITY_CHAOS,
            partition=EvaluationPartition.SECURITY_HOLDOUT,
            security_guardrails={"prompt_injection": True, "crash_resume": True},
        ),
        actor=EvaluationActor.EVALUATOR,
    )


def test_candidate_must_be_trace_grounded_and_cannot_change_forbidden_components() -> None:
    with pytest.raises(ValueError, match="source failure"):
        replace(_candidate(), source_failure_ids=())
    with pytest.raises(ValueError, match="forbidden components"):
        forbidden_components = ("context-ranking", "promotion-policy")
        replace(
            _candidate(),
            changed_components=forbidden_components,
            ablation_plan=CausalAblationPlan(
                changed_components=forbidden_components,
                cells=(
                    frozenset(),
                    frozenset({"context-ranking"}),
                    frozenset({"promotion-policy"}),
                    frozenset(forbidden_components),
                ),
                preregistration_ref=f"artifact://sha256/{'2' * 64}",
            ),
        )
    with pytest.raises(ValueError, match="non-finite"):
        replace(_candidate(), predicted_improvements={"verified_completion": float("nan")})
    with pytest.raises(ValueError, match="content-addressed"):
        replace(_candidate(), configuration_identity="config-v1")
    with pytest.raises(ValueError, match="immutable trace"):
        replace(_candidate().attribution, trace_refs=("/tmp/trace.json",))


def test_multi_component_candidate_requires_causal_ablation_cells() -> None:
    components = ("context-ranking", "tool-ranking")
    with pytest.raises(ValueError, match="singleton"):
        CausalAblationPlan(
            changed_components=components,
            cells=(frozenset(), frozenset(components)),
            preregistration_ref=f"artifact://sha256/{'2' * 64}",
        )
    plan = CausalAblationPlan(
        changed_components=components,
        cells=(
            frozenset(),
            frozenset({"context-ranking"}),
            frozenset({"tool-ranking"}),
            frozenset(components),
        ),
        preregistration_ref=f"artifact://sha256/{'2' * 64}",
    )
    assert len(plan.cells) == 4


def test_optimizer_cannot_read_any_hidden_partition() -> None:
    assert_partition_access(EvaluationActor.OPTIMIZER, EvaluationPartition.TRAINING_FAILURES)
    assert_partition_access(EvaluationActor.OPTIMIZER, EvaluationPartition.DEVELOPMENT)
    for partition in (
        EvaluationPartition.FOCUSED_HOLDOUT,
        EvaluationPartition.BROAD_HOLDOUT,
        EvaluationPartition.SECURITY_HOLDOUT,
        EvaluationPartition.FINAL_RELEASE_HOLDOUT,
    ):
        with pytest.raises(PartitionAccessError):
            assert_partition_access(EvaluationActor.OPTIMIZER, partition)
    with pytest.raises(PartitionAccessError):
        assert_partition_access(
            EvaluationActor.PROMOTION_SERVICE,
            EvaluationPartition.FINAL_RELEASE_HOLDOUT,
        )


def test_validation_ladder_is_ordered_and_only_evaluator_records_receipts() -> None:
    lifecycle = CandidateLifecycle(_candidate())
    with pytest.raises(PermissionError, match="evaluator"):
        lifecycle.record_receipt(_receipt(CandidateStage.STATIC), actor=EvaluationActor.OPTIMIZER)
    with pytest.raises(ValueError, match="expected static"):
        lifecycle.record_receipt(_receipt(CandidateStage.REPLAY), actor=EvaluationActor.EVALUATOR)
    with pytest.raises(ValueError, match="does not match"):
        lifecycle.record_receipt(
            replace(_receipt(CandidateStage.STATIC), candidate_id="candidate-other"),
            actor=EvaluationActor.EVALUATOR,
        )
    with pytest.raises(ValueError, match="partition focused_holdout"):
        _receipt(
            CandidateStage.FOCUSED_HOLDOUT,
            partition=EvaluationPartition.DEVELOPMENT,
        )
    with pytest.raises(ValueError, match="run manifest"):
        replace(_receipt(CandidateStage.STATIC), run_manifest_ref="run.json")
    with pytest.raises(ValueError, match="does not match"):
        replace(_receipt(CandidateStage.STATIC), resolved_configuration_identity=f"sha256:{'d' * 64}")


def test_broad_holdout_requires_transfer_across_models_and_cohorts() -> None:
    lifecycle = CandidateLifecycle(_candidate())
    lifecycle.record_receipt(_receipt(CandidateStage.STATIC), actor=EvaluationActor.EVALUATOR)
    lifecycle.record_receipt(_receipt(CandidateStage.SOURCE_FAILURE), actor=EvaluationActor.EVALUATOR)
    lifecycle.record_receipt(_receipt(CandidateStage.REPLAY), actor=EvaluationActor.EVALUATOR)
    lifecycle.record_receipt(
        _receipt(
            CandidateStage.FOCUSED_HOLDOUT,
            partition=EvaluationPartition.FOCUSED_HOLDOUT,
        ),
        actor=EvaluationActor.EVALUATOR,
    )
    stage = lifecycle.record_receipt(
        _receipt(
            CandidateStage.BROAD_HOLDOUT,
            partition=EvaluationPartition.BROAD_HOLDOUT,
            cohorts=("bug-repair",),
            models=("model-a",),
        ),
        actor=EvaluationActor.EVALUATOR,
    )
    assert stage is CandidateStage.REJECTED
    assert "transfer across cohorts and models" in lifecycle.rollback_reasons[0]


def test_full_ladder_requires_separate_signature_before_canary() -> None:
    lifecycle = CandidateLifecycle(_candidate())
    _advance_to_security(lifecycle)
    assert lifecycle.stage is CandidateStage.SECURITY_CHAOS

    signature = _signature(lifecycle)
    with pytest.raises(PermissionError, match="promotion service"):
        lifecycle.sign(signature, actor=EvaluationActor.OPTIMIZER)
    with pytest.raises(ValueError, match="does not bind"):
        lifecycle.sign(
            replace(signature, receipt_refs=signature.receipt_refs[:-1]),
            actor=EvaluationActor.PROMOTION_SERVICE,
        )
    lifecycle.sign(signature, actor=EvaluationActor.PROMOTION_SERVICE)
    lifecycle.begin_canary(actor=EvaluationActor.PROMOTION_SERVICE)
    assert lifecycle.stage.value == CandidateStage.CANARY.value


def test_canary_prediction_violation_triggers_automatic_rollback() -> None:
    lifecycle = CandidateLifecycle(_candidate())
    _advance_to_security(lifecycle)
    lifecycle.sign(
        _signature(lifecycle),
        actor=EvaluationActor.PROMOTION_SERVICE,
    )
    lifecycle.begin_canary(actor=EvaluationActor.PROMOTION_SERVICE)
    decision = lifecycle.assess_canary(
        CanaryObservation(
            candidate_id="candidate-001",
            candidate_version="git:candidate",
            experiment_id="experiment-001",
            source_commit=COMMIT,
            platform="linux-x86_64",
            run_manifest_ref=f"artifact://sha256/{'f' * 64}",
            configuration_identity=CONFIGURATION,
            resolved_configuration_identity=CONFIGURATION,
            artifact_ref=f"artifact://sha256/{'c' * 64}",
            sample_size=100,
            metric_deltas={
                "verified_completion": 0.01,
                "security_success": 0.0,
                "cost": -0.02,
            },
            security_guardrails={"prompt_injection": True},
        ),
        actor=EvaluationActor.PROMOTION_SERVICE,
        minimum_sample_size=50,
    )
    assert decision is CanaryDecision.ROLLBACK
    assert lifecycle.stage is CandidateStage.ROLLED_BACK
    assert any("prediction violated" in reason for reason in lifecycle.rollback_reasons)


def test_canary_waits_for_sample_then_promotes_when_predictions_hold() -> None:
    lifecycle = CandidateLifecycle(_candidate())
    _advance_to_security(lifecycle)
    lifecycle.sign(
        _signature(lifecycle),
        actor=EvaluationActor.PROMOTION_SERVICE,
    )
    lifecycle.begin_canary(actor=EvaluationActor.PROMOTION_SERVICE)
    observation = CanaryObservation(
        candidate_id="candidate-001",
        candidate_version="git:candidate",
        experiment_id="experiment-001",
        source_commit=COMMIT,
        platform="linux-x86_64",
        run_manifest_ref=f"artifact://sha256/{'f' * 64}",
        configuration_identity=CONFIGURATION,
        resolved_configuration_identity=CONFIGURATION,
        artifact_ref=f"artifact://sha256/{'d' * 64}",
        sample_size=10,
        metric_deltas={
            "verified_completion": 0.04,
            "security_success": 0.0,
            "cost": -0.01,
        },
        security_guardrails={"prompt_injection": True},
    )
    assert (
        lifecycle.assess_canary(
            observation,
            actor=EvaluationActor.PROMOTION_SERVICE,
            minimum_sample_size=50,
        )
        is CanaryDecision.CONTINUE
    )
    assert lifecycle.stage is CandidateStage.CANARY
    assert (
        lifecycle.assess_canary(
            replace(observation, sample_size=50),
            actor=EvaluationActor.PROMOTION_SERVICE,
            minimum_sample_size=50,
        )
        is CanaryDecision.PROMOTE
    )
    assert lifecycle.stage.value == CandidateStage.PROMOTED.value


def test_coevolution_experiment_is_hidden_preregistered_and_factorial() -> None:
    experiment = CoevolutionExperiment(
        experiment_id="coevolution-001",
        model_profiles=("model-b", "model-a"),
        harness_versions=("harness-next", "harness-base"),
        partition=EvaluationPartition.BROAD_HOLDOUT,
        preregistration_ref=f"artifact://sha256/{'e' * 64}",
    )
    assert experiment.cells == (
        ("model-a", "harness-base"),
        ("model-a", "harness-next"),
        ("model-b", "harness-base"),
        ("model-b", "harness-next"),
    )
    with pytest.raises(ValueError, match="hidden"):
        replace(experiment, partition=EvaluationPartition.DEVELOPMENT)


def test_pareto_archive_rejects_unsafe_and_dominated_points() -> None:
    archive = ParetoArchive()
    evidence = f"artifact://sha256/{'9' * 64}"
    baseline = ParetoPoint("baseline", evidence, 0.7, 1.0, 10.0, 2.0, True)
    assert archive.add(baseline)
    assert not archive.add(ParetoPoint("unsafe", evidence, 0.9, 0.8, 8.0, 1.0, False))
    assert not archive.add(ParetoPoint("dominated", evidence, 0.6, 1.2, 12.0, 3.0, True))
    assert archive.add(ParetoPoint("better", evidence, 0.8, 0.9, 9.0, 1.5, True))
    assert [point.candidate_id for point in archive.points] == ["better"]
    with pytest.raises(ValueError, match="measurement evidence"):
        replace(baseline, evidence_ref="metrics.json")


def test_repair_memory_requires_evidence_and_deduplicates_attempts() -> None:
    memory = RepairMemory()
    entry = RepairMemoryEntry(
        flaw_signature="omitted-interface-contract",
        source_failure_ids=("failure-017",),
        attempted_candidate_id="candidate-001",
        measured_effects={"verified_completion": -0.01},
        interactions=("context-budget",),
        rejected_hypotheses=("model-capability",),
        rollback_reasons=("prediction violated",),
        evidence_refs=(f"artifact://sha256/{'c' * 64}",),
    )
    memory.record(entry)
    memory.record(entry)
    assert len(memory.entries) == 1
    with pytest.raises(ValueError, match="immutable evidence"):
        memory.record(replace(entry, evidence_refs=("/tmp/result.json",)))

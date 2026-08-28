"""Terminus evaluation and research laboratory (SPEC §18, §41, §43.3).

This package is the offline / non-privileged research plane for the Terminus
coding-agent operating system. Python is **NOT** on the production enforcement
boundary (SPEC §43.3) — this code performs evaluation analysis, statistical
tests, retrieval/compression experiments, model-routing research, benchmark
data preparation, and dashboard generation.

Reference: SPEC §18 (Evaluation laboratory), §41 (Implementation contract),
§43.3 (Python standards), §46.11 (Eval test tiers), §50 (Promotion checklist).
"""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as _pkg_version

from .baselines import BASELINES, Baseline, baseline_by_id, canonical_baseline_id
from .cohort_tasks import COHORTS, Cohort, cohort_by_id
from .conformance_levels import (
    CONFORMANCE_REQUIREMENTS,
    ConformanceAssessment,
    ConformanceEvidence,
    ConformanceLevel,
    assess_conformance,
)
from .evolution_lab import (
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
from .experiment_manifest import (
    ChangeManifest,
    Decision,
    ExperimentManifest,
    SamplePlan,
)
from .identity import EvaluationIdentity, LockedEvaluationIdentity
from .paired_evaluation import (
    PairedEvaluationEvidence,
    PairIdentityBinding,
    PairingIssue,
    derive_paired_evidence,
)
from .promotion_gate import (
    Evaluation,
    GateStatus,
    PromotionDecision,
    PromotionGateResult,
    evaluate_paired_promotion,
    evaluate_promotion,
)
from .run_record import (
    CostBreakdown,
    GraderResult,
    Outcome,
    RunRecord,
)

try:
    __version__ = _pkg_version("terminus-evals")
except PackageNotFoundError:  # pragma: no cover - dev install fallback
    __version__ = "0.1.0"

__all__ = [
    "BASELINES",
    "COHORTS",
    "CONFORMANCE_REQUIREMENTS",
    "Baseline",
    "CanaryDecision",
    "CanaryObservation",
    "CandidateLifecycle",
    "CandidateStage",
    "CausalAblationPlan",
    "ChangeManifest",
    "CoevolutionExperiment",
    "Cohort",
    "ConformanceAssessment",
    "ConformanceEvidence",
    "ConformanceLevel",
    "CostBreakdown",
    "Decision",
    "Evaluation",
    "EvaluationActor",
    "EvaluationIdentity",
    "EvaluationPartition",
    "EvaluationReceipt",
    "EvolutionCandidate",
    "ExperimentManifest",
    "FailureAttribution",
    "GateStatus",
    "GraderResult",
    "LockedEvaluationIdentity",
    "Outcome",
    "PairIdentityBinding",
    "PairedEvaluationEvidence",
    "PairingIssue",
    "ParetoArchive",
    "ParetoPoint",
    "PartitionAccessError",
    "PromotionDecision",
    "PromotionGateResult",
    "PromotionSignature",
    "RepairMemory",
    "RepairMemoryEntry",
    "RunRecord",
    "SamplePlan",
    "__version__",
    "assert_partition_access",
    "assess_conformance",
    "baseline_by_id",
    "canonical_baseline_id",
    "cohort_by_id",
    "derive_paired_evidence",
    "evaluate_paired_promotion",
    "evaluate_promotion",
]

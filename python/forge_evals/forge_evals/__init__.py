"""Forge evaluation and research laboratory (SPEC §18, §41, §43.3).

This package is the offline / non-privileged research plane for the Forge
coding-agent operating system. Python is **NOT** on the production enforcement
boundary (SPEC §43.3) — this code performs evaluation analysis, statistical
tests, retrieval/compression experiments, model-routing research, benchmark
data preparation, and dashboard generation.

Reference: SPEC §18 (Evaluation laboratory), §41 (Implementation contract),
§43.3 (Python standards), §46.11 (Eval test tiers), §50 (Promotion checklist).
"""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version as _pkg_version

from .baselines import BASELINES, Baseline, baseline_by_id
from .cohort_tasks import COHORTS, Cohort, cohort_by_id
from .experiment_manifest import (
    ChangeManifest,
    Decision,
    ExperimentManifest,
    SamplePlan,
)
from .promotion_gate import (
    Evaluation,
    GateStatus,
    PromotionDecision,
    PromotionGateResult,
    evaluate_promotion,
)
from .run_record import (
    CostBreakdown,
    GraderResult,
    Outcome,
    RunRecord,
)

try:
    __version__ = _pkg_version("forge-evals")
except PackageNotFoundError:  # pragma: no cover - dev install fallback
    __version__ = "0.1.0"

__all__ = [
    "BASELINES",
    "Baseline",
    "ChangeManifest",
    "COHORTS",
    "Cohort",
    "CostBreakdown",
    "Decision",
    "Evaluation",
    "ExperimentManifest",
    "GateStatus",
    "GraderResult",
    "Outcome",
    "PromotionDecision",
    "PromotionGateResult",
    "RunRecord",
    "SamplePlan",
    "__version__",
    "baseline_by_id",
    "cohort_by_id",
    "evaluate_promotion",
]

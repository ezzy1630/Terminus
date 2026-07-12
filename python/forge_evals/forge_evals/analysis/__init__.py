"""SPEC §41.6 analysis pipelines.

Loaders, aggregators, cost / cache analysis, and regression detection.
"""

from __future__ import annotations

from .aggregate import (
    CohortSummary,
    aggregate_by_cohort,
    aggregate_by_harness,
    aggregate_by_harness_cohort,
    summarize_runs,
)
from .cache_analysis import (
    CacheInvalidationCause,
    CacheStats,
    cache_invalidation_causes,
    cache_stats_by_harness_cohort,
    compute_cache_stats,
)
from .cost_analysis import (
    CostAnomaly,
    CostReconciliation,
    find_anomalies,
    reconcile_costs,
    summarize_cost_deltas,
)
from .load_runs import (
    RunCatalog,
    load_runs_from_json_dir,
    load_runs_from_jsonl,
    load_runs_from_parquet,
    load_runs_from_records,
    records_to_dataframe,
)
from .regression_detector import (
    CohortRegression,
    RegressionReport,
    detect_regressions,
    match_pairs,
)

__all__ = [
    "CacheInvalidationCause",
    "CacheStats",
    "CohortRegression",
    "CohortSummary",
    "CostAnomaly",
    "CostReconciliation",
    "RegressionReport",
    "RunCatalog",
    "aggregate_by_cohort",
    "aggregate_by_harness",
    "aggregate_by_harness_cohort",
    "cache_invalidation_causes",
    "cache_stats_by_harness_cohort",
    "compute_cache_stats",
    "detect_regressions",
    "find_anomalies",
    "load_runs_from_json_dir",
    "load_runs_from_jsonl",
    "load_runs_from_parquet",
    "load_runs_from_records",
    "match_pairs",
    "reconcile_costs",
    "records_to_dataframe",
    "summarize_cost_deltas",
    "summarize_runs",
]

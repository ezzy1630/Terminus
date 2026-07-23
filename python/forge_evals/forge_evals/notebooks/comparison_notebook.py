"""SPEC §41 comparison analysis notebook helper module.

Provides analysis routines and DataFrame helpers for interactive evaluation
experiments, ablation studies, and comparative plotting.
"""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path

import polars as pl

from ..analysis.aggregate import summarize_runs
from ..analysis.seed_variance import compute_seed_variance
from ..run_record import RunRecord

__all__ = [
    "build_comparison_dataframe",
    "build_seed_variance_dataframe",
    "export_analysis_dataset",
]


def build_comparison_dataframe(records: Iterable[RunRecord]) -> pl.DataFrame:
    """Build a consolidated Polars DataFrame summarizing harness comparisons."""
    return summarize_runs(records)


def build_seed_variance_dataframe(records: Iterable[RunRecord]) -> pl.DataFrame:
    """Build a Polars DataFrame of multi-seed variance and confidence bounds."""
    res = compute_seed_variance(records)
    if not res:
        return pl.DataFrame()
    return pl.DataFrame([r.to_dict() for r in res])


def export_analysis_dataset(records: Iterable[RunRecord], output_dir: Path | str) -> Path:
    """Export run records and summaries into parquet files for notebook exploration."""
    d = Path(output_dir)
    d.mkdir(parents=True, exist_ok=True)

    recs = list(records)
    summary_df = build_comparison_dataframe(recs)
    variance_df = build_seed_variance_dataframe(recs)

    if not summary_df.is_empty():
        summary_df.write_parquet(d / "cohort_summaries.parquet")
    if not variance_df.is_empty():
        variance_df.write_parquet(d / "seed_variance.parquet")

    return d

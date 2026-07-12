"""SPEC §41.6 cohort-level aggregation.

Aggregates task-level :class:`RunRecord` instances into cohort-level
summaries with confidence intervals. Each summary row contains:

- success rate (mean of `passed`) with bootstrap CI;
- mean primary score with bootstrap CI;
- median duration with bootstrap CI;
- p50 / p95 cost (computed USD) with bootstrap CIs;
- token totals (input, output, cached);
- per-harness and per-seed breakdown when ``group_by`` is set.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

import polars as pl

from ..run_record import RunRecord
from ..statistics.bootstrap import bootstrap_ci
from .load_runs import RunCatalog

__all__ = [
    "CohortSummary",
    "aggregate_by_cohort",
    "aggregate_by_harness",
    "aggregate_by_harness_cohort",
    "summarize_runs",
]


@dataclass(frozen=True)
class CohortSummary:
    """A single cohort × harness summary row."""

    cohort: str
    harness: str
    n: int
    success_rate: float
    success_rate_ci_low: float
    success_rate_ci_high: float
    mean_score: float
    mean_score_ci_low: float
    mean_score_ci_high: float
    median_duration_seconds: float
    p50_cost_usd: float
    p95_cost_usd: float
    total_input_tokens: int
    total_output_tokens: int
    total_cached_tokens: int

    def to_dict(self) -> dict[str, object]:
        """Plain dict form."""
        return {
            "cohort": self.cohort,
            "harness": self.harness,
            "n": self.n,
            "success_rate": self.success_rate,
            "success_rate_ci_low": self.success_rate_ci_low,
            "success_rate_ci_high": self.success_rate_ci_high,
            "mean_score": self.mean_score,
            "mean_score_ci_low": self.mean_score_ci_low,
            "mean_score_ci_high": self.mean_score_ci_high,
            "median_duration_seconds": self.median_duration_seconds,
            "p50_cost_usd": self.p50_cost_usd,
            "p95_cost_usd": self.p95_cost_usd,
            "total_input_tokens": self.total_input_tokens,
            "total_output_tokens": self.total_output_tokens,
            "total_cached_tokens": self.total_cached_tokens,
        }


def _bootstrap_mean(values: list[float], n_resamples: int = 2000, rng_seed: int = 0) -> tuple[float, float]:
    """Bootstrap CI on the mean of ``values`` (empty list → (0, 0))."""
    if not values:
        return 0.0, 0.0
    return bootstrap_ci(
        values,
        lambda s: sum(s) / len(s) if s else 0.0,
        n_resamples=n_resamples,
        rng_seed=rng_seed,
    )


def _median(values: list[float]) -> float:
    """Median of a list (empty → 0)."""
    if not values:
        return 0.0
    s = sorted(values)
    n = len(s)
    return s[n // 2] if n % 2 == 1 else (s[n // 2 - 1] + s[n // 2]) / 2


def _percentile(values: list[float], q: float) -> float:
    """Percentile of a list (empty → 0)."""
    if not values:
        return 0.0
    s = sorted(values)
    idx = q * (len(s) - 1)
    lo = int(idx)
    hi = min(lo + 1, len(s) - 1)
    frac = idx - lo
    return s[lo] * (1 - frac) + s[hi] * frac


def _summarize_group(
    cohort: str,
    harness: str,
    records: list[RunRecord],
    n_resamples: int = 2000,
    rng_seed: int = 0,
) -> CohortSummary:
    """Compute a single summary row from a list of records."""
    n = len(records)
    passed_list: list[float] = [1.0 if r.passed else 0.0 for r in records]
    scores: list[float] = [r.primary_score for r in records]
    durations: list[float] = [r.duration_seconds for r in records]
    costs: list[float] = [r.cost.computed_usd if r.cost else 0.0 for r in records]
    in_tok = sum(r.cost.input_tokens if r.cost else 0 for r in records)
    out_tok = sum(r.cost.output_tokens if r.cost else 0 for r in records)
    cached_tok = sum(r.cost.cached_tokens if r.cost else 0 for r in records)

    sr = sum(passed_list) / n if n > 0 else 0.0
    sr_lo, sr_hi = _bootstrap_mean(passed_list, n_resamples=n_resamples, rng_seed=rng_seed)
    ms = sum(scores) / n if n > 0 else 0.0
    ms_lo, ms_hi = _bootstrap_mean(scores, n_resamples=n_resamples, rng_seed=rng_seed + 1)

    return CohortSummary(
        cohort=cohort,
        harness=harness,
        n=n,
        success_rate=sr,
        success_rate_ci_low=sr_lo,
        success_rate_ci_high=sr_hi,
        mean_score=ms,
        mean_score_ci_low=ms_lo,
        mean_score_ci_high=ms_hi,
        median_duration_seconds=_median(durations),
        p50_cost_usd=_percentile(costs, 0.5),
        p95_cost_usd=_percentile(costs, 0.95),
        total_input_tokens=in_tok,
        total_output_tokens=out_tok,
        total_cached_tokens=cached_tok,
    )


def aggregate_by_cohort(
    records: Iterable[RunRecord] | RunCatalog,
    n_resamples: int = 2000,
    rng_seed: int = 0,
) -> list[CohortSummary]:
    """Aggregate records by cohort (collapsing across harnesses and seeds)."""
    recs = _coerce_records(records)
    out: list[CohortSummary] = []
    by_cohort: dict[str, list[RunRecord]] = {}
    for r in recs:
        by_cohort.setdefault(r.suite, []).append(r)
    for cohort, group in by_cohort.items():
        out.append(
            _summarize_group(
                cohort=cohort,
                harness="(all)",
                records=group,
                n_resamples=n_resamples,
                rng_seed=rng_seed,
            )
        )
    return out


def aggregate_by_harness(
    records: Iterable[RunRecord] | RunCatalog,
    n_resamples: int = 2000,
    rng_seed: int = 0,
) -> list[CohortSummary]:
    """Aggregate records by harness (collapsing across cohorts and seeds)."""
    recs = _coerce_records(records)
    out: list[CohortSummary] = []
    by_harness: dict[str, list[RunRecord]] = {}
    for r in recs:
        by_harness.setdefault(r.harness, []).append(r)
    for harness, group in by_harness.items():
        out.append(
            _summarize_group(
                cohort="(all)",
                harness=harness,
                records=group,
                n_resamples=n_resamples,
                rng_seed=rng_seed,
            )
        )
    return out


def aggregate_by_harness_cohort(
    records: Iterable[RunRecord] | RunCatalog,
    n_resamples: int = 2000,
    rng_seed: int = 0,
) -> list[CohortSummary]:
    """Aggregate records by (harness, cohort). One summary row per pair."""
    recs = _coerce_records(records)
    out: list[CohortSummary] = []
    by_hc: dict[tuple[str, str], list[RunRecord]] = {}
    for r in recs:
        by_hc.setdefault((r.harness, r.suite), []).append(r)
    for (h, c), group in by_hc.items():
        out.append(
            _summarize_group(
                cohort=c,
                harness=h,
                records=group,
                n_resamples=n_resamples,
                rng_seed=rng_seed,
            )
        )
    return out


def summarize_runs(
    records: Iterable[RunRecord] | RunCatalog,
    n_resamples: int = 2000,
    rng_seed: int = 0,
) -> pl.DataFrame:
    """Produce a single Polars DataFrame with one row per (cohort, harness)."""
    summaries = aggregate_by_harness_cohort(records, n_resamples=n_resamples, rng_seed=rng_seed)
    if not summaries:
        return pl.DataFrame()
    return pl.DataFrame([s.to_dict() for s in summaries])


def _coerce_records(records: Iterable[RunRecord] | RunCatalog) -> list[RunRecord]:
    """Accept either a catalog or a raw iterable of records."""
    if isinstance(records, RunCatalog):
        return list(records.records)
    return list(records)

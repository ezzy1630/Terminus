"""SPEC §41.6 / audit requirement: Multi-seed variance and confidence bounds.

Computes variance, standard error, and bootstrap confidence intervals across
repeated random seeds for task-level and cohort-level evaluation runs.
"""

from __future__ import annotations

import math
from collections.abc import Iterable
from dataclasses import dataclass

from ..run_record import RunRecord
from ..statistics.bootstrap import bootstrap_ci
from .load_runs import RunCatalog

__all__ = ["SeedVarianceResult", "compute_seed_variance"]


@dataclass(frozen=True)
class SeedVarianceResult:
    """Variance analysis across repeated random seeds for a single task/harness combination."""

    harness: str
    suite: str
    task: str
    seeds: list[int]
    n_runs: int
    passed_rate: float
    mean_score: float
    score_std: float
    score_sem: float
    score_ci_low: float
    score_ci_high: float
    duration_mean: float
    duration_std: float
    cost_mean: float
    cost_std: float

    def to_dict(self) -> dict[str, object]:
        return {
            "harness": self.harness,
            "suite": self.suite,
            "task": self.task,
            "seeds": self.seeds,
            "n_runs": self.n_runs,
            "passed_rate": self.passed_rate,
            "mean_score": self.mean_score,
            "score_std": self.score_std,
            "score_sem": self.score_sem,
            "score_ci_low": self.score_ci_low,
            "score_ci_high": self.score_ci_high,
            "duration_mean": self.duration_mean,
            "duration_std": self.duration_std,
            "cost_mean": self.cost_mean,
            "cost_std": self.cost_std,
        }


def _mean(vals: list[float]) -> float:
    return sum(vals) / len(vals) if vals else 0.0


def _std(vals: list[float], mean_val: float) -> float:
    if len(vals) <= 1:
        return 0.0
    var = sum((x - mean_val) ** 2 for x in vals) / (len(vals) - 1)
    return math.sqrt(var)


def compute_seed_variance(
    records: Iterable[RunRecord] | RunCatalog,
    n_resamples: int = 1000,
    rng_seed: int = 42,
) -> list[SeedVarianceResult]:
    """Group records by (harness, suite, task) and compute multi-seed variance statistics."""
    recs = list(records.records) if isinstance(records, RunCatalog) else list(records)
    by_hst: dict[tuple[str, str, str], list[RunRecord]] = {}
    for r in recs:
        by_hst.setdefault((r.harness, r.suite, r.task), []).append(r)

    results: list[SeedVarianceResult] = []
    for (harness, suite, task), group in by_hst.items():
        seeds = [r.random_seed for r in group]
        n = len(group)
        passed_list = [1.0 if r.passed else 0.0 for r in group]
        scores = [r.primary_score for r in group]
        durations = [r.duration_seconds for r in group]
        costs = [r.cost.computed_usd if r.cost else 0.0 for r in group]

        passed_rate = _mean(passed_list)
        ms = _mean(scores)
        s_std = _std(scores, ms)
        s_sem = s_std / math.sqrt(n) if n > 0 else 0.0

        if n >= 2:
            ci_lo, ci_hi = bootstrap_ci(
                scores,
                lambda s: sum(s) / len(s) if s else 0.0,
                n_resamples=n_resamples,
                rng_seed=rng_seed,
            )
        else:
            ci_lo, ci_hi = ms, ms

        dur_m = _mean(durations)
        dur_std = _std(durations, dur_m)
        cost_m = _mean(costs)
        cost_std = _std(costs, cost_m)

        results.append(
            SeedVarianceResult(
                harness=harness,
                suite=suite,
                task=task,
                seeds=seeds,
                n_runs=n,
                passed_rate=passed_rate,
                mean_score=ms,
                score_std=s_std,
                score_sem=s_sem,
                score_ci_low=ci_lo,
                score_ci_high=ci_hi,
                duration_mean=dur_m,
                duration_std=dur_std,
                cost_mean=cost_m,
                cost_std=cost_std,
            )
        )

    return results

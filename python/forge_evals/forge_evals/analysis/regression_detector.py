"""SPEC §41.6 regression detector.

Detects regressions across run sets using paired statistical tests. A
*regression* is a statistically significant decrease in the primary metric
on a critical cohort, with the magnitude exceeding a pre-registered
threshold.

This module compares a *baseline* run set against a *candidate* run set on
matched (task, seed) pairs and produces a :class:`RegressionReport` that
the promotion gate consumes.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field

from ..run_record import RunRecord
from ..statistics.bootstrap import bootstrap_ci
from ..statistics.noninferiority import NonInferiorityResult, noninferiority_binary
from ..statistics.paired import (
    McNemarResult,
    PairedDelta,
    PairedSequence,
    mc_nemar,
    paired_t_test,
)
from .load_runs import RunCatalog

__all__ = [
    "CohortRegression",
    "RegressionReport",
    "RegressionVerdict",
    "detect_regressions",
    "match_pairs",
]


class RegressionVerdict(str):
    """Per-cohort regression verdict."""


@dataclass(frozen=True)
class CohortRegression:
    """A single cohort's regression analysis."""

    cohort: str
    n_pairs: int
    mean_delta: float
    mean_delta_ci_low: float
    mean_delta_ci_high: float
    median_delta: float
    cohens_d: float
    mcnemar_statistic: float
    mcnemar_p_value: float
    mcnemar_discordant: int
    noninferiority: NonInferiorityResult
    verdict: str  # "improvement" | "regression" | "no_change" | "inconclusive"
    regression_magnitude: float = 0.0

    def to_dict(self) -> dict[str, object]:
        """Plain dict form."""
        return {
            "cohort": self.cohort,
            "n_pairs": self.n_pairs,
            "mean_delta": self.mean_delta,
            "mean_delta_ci_low": self.mean_delta_ci_low,
            "mean_delta_ci_high": self.mean_delta_ci_high,
            "median_delta": self.median_delta,
            "cohens_d": self.cohens_d,
            "mcnemar_statistic": self.mcnemar_statistic,
            "mcnemar_p_value": self.mcnemar_p_value,
            "mcnemar_discordant": self.mcnemar_discordant,
            "noninferiority_is_noninferior": self.noninferiority.is_noninferior,
            "noninferiority_ci_low": self.noninferiority.ci_low,
            "verdict": self.verdict,
            "regression_magnitude": self.regression_magnitude,
        }


@dataclass
class RegressionReport:
    """The full regression report across all cohorts.

    ``regressed_cohorts`` is the list of cohorts where the verdict is
    "regression". This list feeds the promotion gate's regression check.
    """

    baseline_label: str
    candidate_label: str
    cohort_results: list[CohortRegression] = field(default_factory=list)

    @property
    def regressed_cohorts(self) -> list[str]:
        """Cohorts where the verdict is 'regression'."""
        return [c.cohort for c in self.cohort_results if c.verdict == "regression"]

    @property
    def improved_cohorts(self) -> list[str]:
        """Cohorts where the verdict is 'improvement'."""
        return [c.cohort for c in self.cohort_results if c.verdict == "improvement"]

    def to_dict(self) -> dict[str, object]:
        """Plain dict form."""
        return {
            "baseline_label": self.baseline_label,
            "candidate_label": self.candidate_label,
            "cohort_results": [c.to_dict() for c in self.cohort_results],
            "regressed_cohorts": self.regressed_cohorts,
            "improved_cohorts": self.improved_cohorts,
        }


def match_pairs(
    baseline: Iterable[RunRecord] | RunCatalog,
    candidate: Iterable[RunRecord] | RunCatalog,
) -> list[tuple[RunRecord, RunRecord]]:
    """Match records by (task, random_seed).

    Returns a list of (baseline, candidate) pairs. Records present in only
    one side are dropped (with a warning if you want to inspect).
    """
    b_list = _coerce(baseline)
    c_list = _coerce(candidate)
    b_index: dict[tuple[str, int], RunRecord] = {(r.task, r.random_seed): r for r in b_list}
    c_index: dict[tuple[str, int], RunRecord] = {(r.task, r.random_seed): r for r in c_list}
    keys = sorted(set(b_index.keys()) & set(c_index.keys()))
    return [(b_index[k], c_index[k]) for k in keys]


def detect_regressions(
    baseline: Iterable[RunRecord] | RunCatalog,
    candidate: Iterable[RunRecord] | RunCatalog,
    *,
    baseline_label: str = "baseline",
    candidate_label: str = "candidate",
    noninferiority_margin: float = 0.05,
    alpha: float = 0.025,
    regression_threshold: float = 0.0,
    n_bootstrap: int = 2000,
    rng_seed: int = 0,
) -> RegressionReport:
    """Detect regressions across all cohorts present in either run set.

    For each cohort:

    1. Match (task, seed) pairs between baseline and candidate.
    2. Compute per-pair deltas on ``primary_score``.
    3. Run a paired t-test and McNemar's test on pass/fail.
    4. Run a non-inferiority test with the given margin.
    5. Classify the verdict:

       - ``improvement`` — mean delta > 0 and CI excludes 0;
       - ``regression`` — mean delta < -regression_threshold and CI excludes 0;
       - ``no_change`` — CI includes 0;
       - ``inconclusive`` — too few pairs to decide.

    ``regression_threshold`` lets you require a non-trivial magnitude
    before calling something a regression (avoid noise).
    """
    pairs = match_pairs(baseline, candidate)
    by_cohort: dict[str, list[tuple[RunRecord, RunRecord]]] = {}
    for b, c in pairs:
        by_cohort.setdefault(b.suite, []).append((b, c))

    report = RegressionReport(baseline_label=baseline_label, candidate_label=candidate_label)
    for cohort, cohort_pairs in sorted(by_cohort.items()):
        deltas_scores = PairedSequence(
            deltas=[
                PairedDelta(task=b.task, baseline=b.primary_score, candidate=c.primary_score)
                for b, c in cohort_pairs
            ]
        )
        b_passed = [b.passed for b, _ in cohort_pairs]
        c_passed = [c.passed for _, c in cohort_pairs]
        mcnemar_res: McNemarResult = mc_nemar(b_passed, c_passed)
        t_res = paired_t_test(deltas_scores)
        d_obj = t_res.effect_size or 0.0
        # Bootstrap CI on mean delta.
        ci_low, ci_high = bootstrap_ci(
            deltas_scores.values,
            lambda s: sum(s) / len(s) if s else 0.0,
            n_resamples=n_bootstrap,
            rng_seed=rng_seed,
        )
        # McNemar returns int statistic for exact tests; cast to float.
        mcn_stat = float(mcnemar_res.statistic)
        # Non-inferiority on binary outcomes.
        ni = noninferiority_binary(c_passed, b_passed, margin=noninferiority_margin, alpha=alpha)
        # Verdict.
        mean_delta = (
            sum(deltas_scores.values) / len(deltas_scores.values) if deltas_scores.values else 0.0
        )
        if len(cohort_pairs) < 5:
            verdict = "inconclusive"
        elif mean_delta > 0 and ci_low > 0:
            verdict = "improvement"
        elif mean_delta < -regression_threshold and ci_high < 0:
            verdict = "regression"
        else:
            verdict = "no_change"
        report.cohort_results.append(
            CohortRegression(
                cohort=cohort,
                n_pairs=len(cohort_pairs),
                mean_delta=mean_delta,
                mean_delta_ci_low=ci_low,
                mean_delta_ci_high=ci_high,
                median_delta=_median(deltas_scores.values),
                cohens_d=d_obj,
                mcnemar_statistic=mcn_stat,
                mcnemar_p_value=mcnemar_res.p_value,
                mcnemar_discordant=mcnemar_res.discordant,
                noninferiority=ni,
                verdict=verdict,
                regression_magnitude=abs(min(0.0, mean_delta)),
            )
        )
    return report


def _median(values: list[float]) -> float:
    """Median of a list (empty → 0)."""
    if not values:
        return 0.0
    s = sorted(values)
    n = len(s)
    return s[n // 2] if n % 2 == 1 else (s[n // 2 - 1] + s[n // 2]) / 2


def _coerce(records: Iterable[RunRecord] | RunCatalog) -> list[RunRecord]:
    """Accept either a catalog or a raw iterable of records."""
    if isinstance(records, RunCatalog):
        return list(records.records)
    return list(records)

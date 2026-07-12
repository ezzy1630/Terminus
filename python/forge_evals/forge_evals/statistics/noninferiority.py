"""SPEC §18.7 / §41.6 / §41.12 non-inferiority tests.

A *non-inferiority* test asks: is the candidate *at least as good as* the
baseline, within a pre-registered margin ``delta``? This is the
"no unacceptable regressions" gate of SPEC §18.7 / §41.12.

This module provides:

- :func:`noninferiority_t_test` — one-sided t-test on paired deltas.
- :func:`noninferiority_proportion` — one-sided test on a proportion.
- :func:`noninferiority_binary` — risk-difference test for binary outcomes.

All tests use a pre-registered non-inferiority margin ``delta`` (positive
for "candidate is allowed to be at most delta worse"). The null hypothesis
is H0: candidate is *more than* delta worse than baseline; rejection
supports the claim of non-inferiority.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Sequence

from .bootstrap import _normal_cdf, _normal_ppf

__all__ = [
    "NonInferiorityResult",
    "noninferiority_binary",
    "noninferiority_proportion",
    "noninferiority_t_test",
]


@dataclass(frozen=True)
class NonInferiorityResult:
    """A non-inferiority test verdict."""

    metric: str
    margin: float  # the non-inferiority margin delta (>= 0)
    test_statistic: float
    p_value: float
    ci_low: float  # lower bound of the (1 - 2*alpha) CI on candidate - baseline
    ci_high: float
    is_noninferior: bool
    n: int
    alpha: float
    extras: dict[str, float] = field(default_factory=dict)

    def to_dict(self) -> dict[str, object]:
        """Plain dict form."""
        return {
            "metric": self.metric,
            "margin": self.margin,
            "test_statistic": self.test_statistic,
            "p_value": self.p_value,
            "ci_low": self.ci_low,
            "ci_high": self.ci_high,
            "is_noninferior": self.is_noninferior,
            "n": self.n,
            "alpha": self.alpha,
            "extras": dict(self.extras),
        }


def noninferiority_t_test(
    deltas: Sequence[float],
    margin: float,
    alpha: float = 0.025,
) -> NonInferiorityResult:
    """One-sided paired t-test for non-inferiority.

    H0: mean(delta) < -margin (candidate is *more than* margin worse).
    H1: mean(delta) >= -margin (candidate is non-inferior).

    Reject H0 iff the lower (1 - 2*alpha) confidence bound on mean(delta)
    is >= -margin. Equivalently, the test statistic
    ``t = (mean(delta) + margin) / (sd / sqrt(n))`` exceeds the
    ``1 - alpha`` quantile of the t-distribution.
    """
    n = len(deltas)
    if n < 2:
        return NonInferiorityResult(
            metric="mean_delta",
            margin=margin,
            test_statistic=0.0,
            p_value=1.0,
            ci_low=0.0,
            ci_high=0.0,
            is_noninferior=False,
            n=n,
            alpha=alpha,
        )
    mean = sum(deltas) / n
    var = sum((d - mean) ** 2 for d in deltas) / (n - 1)
    sd = math.sqrt(var)
    se = sd / math.sqrt(n)
    if se == 0:
        # All deltas identical.
        is_ni = mean >= -margin
        return NonInferiorityResult(
            metric="mean_delta",
            margin=margin,
            test_statistic=float("inf") if is_ni else float("-inf"),
            p_value=0.0 if is_ni else 1.0,
            ci_low=mean,
            ci_high=mean,
            is_noninferior=is_ni,
            n=n,
            alpha=alpha,
        )
    t = (mean + margin) / se
    df = n - 1
    # p-value is P(T_df <= t) under H0.
    from .paired import _t_distribution_two_sided_p

    # One-sided: P(T <= t) = 1 - (one-tailed of -t).
    # We want P(T_df > t) = 0.5 * two_sided(t) for symmetric t.
    p_two_sided = _t_distribution_two_sided_p(t, df)
    p_one_sided = p_two_sided / 2 if t > 0 else 1 - p_two_sided / 2
    # CI lower bound (one-sided (1 - alpha) lower bound).
    z_crit = _t_quantile_onesided(1 - alpha, df)
    ci_low = mean - z_crit * se
    ci_high = mean + z_crit * se
    is_ni = ci_low >= -margin
    return NonInferiorityResult(
        metric="mean_delta",
        margin=margin,
        test_statistic=t,
        p_value=p_one_sided,
        ci_low=ci_low,
        ci_high=ci_high,
        is_noninferior=is_ni,
        n=n,
        alpha=alpha,
        extras={"mean_delta": mean, "sd_delta": sd, "se": se, "df": df, "z_crit": z_crit},
    )


def noninferiority_proportion(
    successes_candidate: int,
    n_candidate: int,
    successes_baseline: int,
    n_baseline: int,
    margin: float,
    alpha: float = 0.025,
) -> NonInferiorityResult:
    """Non-inferiority test on two proportions (risk-difference).

    H0: p_candidate - p_baseline <= -margin.
    H1: p_candidate - p_baseline > -margin.

    Uses the Farrington-Manning score test.
    """
    if n_candidate <= 0 or n_baseline <= 0:
        raise ValueError("sample sizes must be positive")
    if not 0 <= successes_candidate <= n_candidate:
        raise ValueError("successes_candidate must be in [0, n_candidate]")
    if not 0 <= successes_baseline <= n_baseline:
        raise ValueError("successes_baseline must be in [0, n_baseline]")
    p_c = successes_candidate / n_candidate
    p_b = successes_baseline / n_baseline
    # Pooled proportion under the null (constrained MLE).
    # Solve: p_c_null = p_b_null - margin, with the constraint that the
    # weighted average equals the observed pooled rate.
    p_pool = (successes_candidate + successes_baseline) / (n_candidate + n_baseline)
    # Iteratively solve for p_b_null such that:
    # (n_c * (p_b_null - margin) + n_b * p_b_null) / (n_c + n_b) = p_pool
    # → p_b_null = p_pool + n_c * margin / (n_c + n_b)
    p_b_null = p_pool + n_candidate * margin / (n_candidate + n_baseline)
    p_c_null = p_b_null - margin
    # Clamp to [0, 1].
    p_b_null = max(0.0, min(1.0, p_b_null))
    p_c_null = max(0.0, min(1.0, p_c_null))
    # Score statistic.
    var_null = (
        p_c_null * (1 - p_c_null) / n_candidate + p_b_null * (1 - p_b_null) / n_baseline
    )
    if var_null == 0:
        is_ni = (p_c - p_b) >= -margin
        return NonInferiorityResult(
            metric="proportion_diff",
            margin=margin,
            test_statistic=float("inf") if is_ni else float("-inf"),
            p_value=0.0 if is_ni else 1.0,
            ci_low=p_c - p_b,
            ci_high=p_c - p_b,
            is_noninferior=is_ni,
            n=n_candidate + n_baseline,
            alpha=alpha,
        )
    z = ((p_c - p_b) + margin) / math.sqrt(var_null)
    p_value = 1 - _normal_cdf(z)
    z_crit = _normal_ppf(1 - alpha)
    # (1 - 2*alpha) CI on the risk difference.
    se_obs = math.sqrt(
        p_c * (1 - p_c) / n_candidate + p_b * (1 - p_b) / n_baseline
    )
    if se_obs == 0:
        ci_low = p_c - p_b
        ci_high = p_c - p_b
    else:
        ci_low = (p_c - p_b) - z_crit * se_obs
        ci_high = (p_c - p_b) + z_crit * se_obs
    is_ni = ci_low >= -margin
    return NonInferiorityResult(
        metric="proportion_diff",
        margin=margin,
        test_statistic=z,
        p_value=p_value,
        ci_low=ci_low,
        ci_high=ci_high,
        is_noninferior=is_ni,
        n=n_candidate + n_baseline,
        alpha=alpha,
        extras={
            "p_candidate": p_c,
            "p_baseline": p_b,
            "p_candidate_null": p_c_null,
            "p_baseline_null": p_b_null,
            "z_crit": z_crit,
        },
    )


def noninferiority_binary(
    passed_candidate: Sequence[bool],
    passed_baseline: Sequence[bool],
    margin: float,
    alpha: float = 0.025,
) -> NonInferiorityResult:
    """Non-inferiority test on paired binary outcomes (pass/fail).

    Computes the per-task pass-rate difference and delegates to
    :func:`noninferiority_proportion`.
    """
    if len(passed_candidate) != len(passed_baseline):
        raise ValueError("sequences must be the same length")
    n_c = sum(1 for x in passed_candidate if x)
    n_b = sum(1 for x in passed_baseline if x)
    n = len(passed_baseline)
    return noninferiority_proportion(
        successes_candidate=n_c,
        n_candidate=n,
        successes_baseline=n_b,
        n_baseline=n,
        margin=margin,
        alpha=alpha,
    )


def _t_quantile_onesided(p: float, df: int) -> float:
    """One-sided t-quantile via the inverse of the regularized incomplete beta.

    For one-sided (1-alpha) CI we want the value t* such that
    P(T_df <= t*) = p. We approximate this via the normal quantile for
    df >= 30 and via a small bisection for smaller df. The bisection path
    is exact to the resolution of the t-distribution CDF.
    """
    if df >= 30:
        return _normal_ppf(p)
    # Bisection on the t-distribution CDF.
    from .paired import _t_distribution_two_sided_p

    def _cdf(t: float) -> float:
        # P(T <= t) = 1 - 0.5 * two_sided(t) for t > 0; 0.5 * two_sided(t) for t < 0.
        if t == 0:
            return 0.5
        ts = _t_distribution_two_sided_p(t, df)
        return 1 - 0.5 * ts if t > 0 else 0.5 * ts

    lo, hi = -50.0, 50.0
    for _ in range(200):
        mid = (lo + hi) / 2
        if _cdf(mid) < p:
            lo = mid
        else:
            hi = mid
        if hi - lo < 1e-6:
            break
    return (lo + hi) / 2

"""SPEC §41.6 bootstrap confidence intervals.

The bootstrap is a non-parametric method for estimating the sampling
distribution of a statistic by resampling with replacement. SPEC §41.6
requires bootstrap CIs for aggregate deltas.

This module provides:

- :func:`bootstrap_samples` — generate bootstrap resamples.
- :func:`bootstrap_distribution` — compute the statistic on each resample.
- :func:`bootstrap_ci` — percentile-method CI from the bootstrap distribution.
- :func:`bootstrap_ci_bca` — BCa (bias-corrected accelerated) CI.
- :func:`bootstrap_p_value` — bootstrap p-value for a null hypothesis.

All functions are deterministic given ``rng_seed``.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass
from typing import Callable, Sequence

__all__ = [
    "BootstrapCI",
    "BootstrapDistribution",
    "bootstrap_ci",
    "bootstrap_ci_bca",
    "bootstrap_distribution",
    "bootstrap_p_value",
    "bootstrap_samples",
]


@dataclass(frozen=True)
class BootstrapDistribution:
    """The statistic evaluated on each bootstrap resample."""

    samples: list[float]
    point_estimate: float
    n: int
    n_resamples: int
    rng_seed: int

    @property
    def mean(self) -> float:
        """Mean of the bootstrap distribution."""
        return sum(self.samples) / len(self.samples) if self.samples else 0.0

    @property
    def standard_error(self) -> float:
        """Standard error of the statistic (std of bootstrap distribution)."""
        if len(self.samples) < 2:
            return 0.0
        m = self.mean
        var = sum((s - m) ** 2 for s in self.samples) / (len(self.samples) - 1)
        return math.sqrt(var)

    def percentile(self, q: float) -> float:
        """Return the q-th quantile (q in [0, 1]) of the bootstrap distribution."""
        if not self.samples:
            return 0.0
        sorted_samples = sorted(self.samples)
        # Linear interpolation between order statistics.
        idx = q * (len(sorted_samples) - 1)
        lo = int(idx)
        hi = min(lo + 1, len(sorted_samples) - 1)
        frac = idx - lo
        return sorted_samples[lo] * (1 - frac) + sorted_samples[hi] * frac


@dataclass(frozen=True)
class BootstrapCI:
    """A bootstrap confidence interval."""

    point_estimate: float
    ci_low: float
    ci_high: float
    confidence_level: float
    method: str  # "percentile" | "bca"
    n_resamples: int
    standard_error: float


# ──────────────────────────── resampling ──────────────────────────────────


def bootstrap_samples(
    sample: Sequence[float],
    n_resamples: int,
    rng_seed: int = 0,
) -> list[list[float]]:
    """Generate ``n_resamples`` bootstrap resamples of ``sample``.

    Each resample has the same length as ``sample`` and is drawn with
    replacement.
    """
    rng = random.Random(rng_seed)
    n = len(sample)
    if n == 0:
        return [[] for _ in range(n_resamples)]
    return [[sample[rng.randrange(n)] for _ in range(n)] for _ in range(n_resamples)]


def bootstrap_distribution(
    sample: Sequence[float],
    statistic: Callable[[Sequence[float]], float],
    n_resamples: int = 10000,
    rng_seed: int = 0,
) -> BootstrapDistribution:
    """Compute the statistic on each of ``n_resamples`` bootstrap resamples."""
    point = statistic(sample)
    resamples = bootstrap_samples(sample, n_resamples, rng_seed=rng_seed)
    samples = [statistic(s) for s in resamples]
    return BootstrapDistribution(
        samples=samples,
        point_estimate=point,
        n=len(sample),
        n_resamples=n_resamples,
        rng_seed=rng_seed,
    )


# ──────────────────────────── percentile CI ───────────────────────────────


def bootstrap_ci(
    sample: Sequence[float],
    statistic: Callable[[Sequence[float]], float],
    confidence_level: float = 0.95,
    n_resamples: int = 10000,
    rng_seed: int = 0,
) -> tuple[float, float]:
    """Percentile-method bootstrap CI for ``statistic(sample)``.

    Returns ``(ci_low, ci_high)`` such that the central ``confidence_level``
    fraction of the bootstrap distribution lies between them.
    """
    if not 0 < confidence_level < 1:
        raise ValueError("confidence_level must be in (0, 1)")
    dist = bootstrap_distribution(sample, statistic, n_resamples=n_resamples, rng_seed=rng_seed)
    alpha = 1 - confidence_level
    return dist.percentile(alpha / 2), dist.percentile(1 - alpha / 2)


def bootstrap_ci_obj(
    sample: Sequence[float],
    statistic: Callable[[Sequence[float]], float],
    confidence_level: float = 0.95,
    n_resamples: int = 10000,
    rng_seed: int = 0,
) -> BootstrapCI:
    """Object form of :func:`bootstrap_ci` — returns a :class:`BootstrapCI`."""
    if not 0 < confidence_level < 1:
        raise ValueError("confidence_level must be in (0, 1)")
    dist = bootstrap_distribution(sample, statistic, n_resamples=n_resamples, rng_seed=rng_seed)
    alpha = 1 - confidence_level
    return BootstrapCI(
        point_estimate=dist.point_estimate,
        ci_low=dist.percentile(alpha / 2),
        ci_high=dist.percentile(1 - alpha / 2),
        confidence_level=confidence_level,
        method="percentile",
        n_resamples=n_resamples,
        standard_error=dist.standard_error,
    )


# ──────────────────────────── BCa CI ──────────────────────────────────────


def bootstrap_ci_bca(
    sample: Sequence[float],
    statistic: Callable[[Sequence[float]], float],
    confidence_level: float = 0.95,
    n_resamples: int = 10000,
    rng_seed: int = 0,
) -> BootstrapCI:
    """BCa (bias-corrected and accelerated) bootstrap CI.

    The BCa interval adjusts the percentile bounds for bias and skewness.
    The bias-correction factor ``z0`` is computed from the proportion of
    bootstrap samples below the point estimate. The acceleration factor
    ``a`` is computed via jackknife leave-one-out.
    """
    if not 0 < confidence_level < 1:
        raise ValueError("confidence_level must be in (0, 1)")
    if len(sample) < 2:
        return bootstrap_ci_obj(
            sample, statistic, confidence_level, n_resamples, rng_seed
        )

    dist = bootstrap_distribution(sample, statistic, n_resamples=n_resamples, rng_seed=rng_seed)
    point = dist.point_estimate

    # Bias-correction z0.
    below = sum(1 for s in dist.samples if s < point)
    prop = below / len(dist.samples) if dist.samples else 0.5
    if prop == 0:
        z0 = float("-inf")
    elif prop == 1:
        z0 = float("inf")
    else:
        z0 = _normal_ppf(prop)

    # Acceleration a via jackknife.
    jackknife_stats = [
        statistic([sample[j] for j in range(len(sample)) if j != i])
        for i in range(len(sample))
    ]
    jack_mean = sum(jackknife_stats) / len(jackknife_stats)
    num = sum((jack_mean - j) ** 3 for j in jackknife_stats)
    den = 6 * (sum((jack_mean - j) ** 2 for j in jackknife_stats) ** 1.5)
    a = num / den if den != 0 else 0.0

    alpha = 1 - confidence_level
    z_lo = _normal_ppf(alpha / 2)
    z_hi = _normal_ppf(1 - alpha / 2)

    def _adjust(z: float) -> float:
        if z0 in (float("inf"), float("-inf")) or (z + z0 == 0):
            return 0.5
        denom = 1 - a * (z + z0)
        if denom == 0:
            return 0.5
        return _normal_cdf(z0 + (z0 + z) / denom)

    p_lo = _adjust(z_lo)
    p_hi = _adjust(z_hi)
    return BootstrapCI(
        point_estimate=point,
        ci_low=dist.percentile(p_lo),
        ci_high=dist.percentile(p_hi),
        confidence_level=confidence_level,
        method="bca",
        n_resamples=n_resamples,
        standard_error=dist.standard_error,
    )


# ──────────────────────────── p-value ─────────────────────────────────────


def bootstrap_p_value(
    sample: Sequence[float],
    statistic: Callable[[Sequence[float]], float],
    null_value: float = 0.0,
    n_resamples: int = 10000,
    rng_seed: int = 0,
) -> float:
    """Bootstrap two-sided p-value for H0: statistic(sample) == null_value.

    Shifts the sample so the null is true (each value minus its mean plus
    null_value), bootstraps the statistic on the shifted sample, and
    computes the proportion of bootstrap statistics at least as extreme
    as the observed statistic.
    """
    if not sample:
        return 1.0
    observed = statistic(sample)
    shifted = [x - observed + null_value for x in sample]
    dist = bootstrap_distribution(shifted, statistic, n_resamples=n_resamples, rng_seed=rng_seed)
    if not dist.samples:
        return 1.0
    more_extreme = sum(
        1 for s in dist.samples if abs(s - null_value) >= abs(observed - null_value)
    )
    return more_extreme / len(dist.samples)


# ──────────────────────────── normal helpers ──────────────────────────────


def _normal_cdf(z: float) -> float:
    """Standard normal CDF."""
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))


def _normal_ppf(p: float) -> float:
    """Inverse standard normal CDF (quantile function).

    Beasley-Springer-Moro algorithm. Accurate to ~7 significant figures.
    """
    if not 0 < p < 1:
        raise ValueError(f"p must be in (0,1), got {p}")
    # Acklam's algorithm.
    a = [
        -3.969683028665376e01,
        2.209460984245205e02,
        -2.759285104469687e02,
        1.383577518672690e02,
        -3.066479806614716e01,
        2.506628277459239e00,
    ]
    b = [
        -5.447609879822406e01,
        1.615858368580409e02,
        -1.556989798598866e02,
        6.680131188771972e01,
        -1.328068155288572e01,
    ]
    c = [
        -7.784894002430293e-03,
        -3.223964580411365e-01,
        -2.400758277161838e00,
        -2.549732539343734e00,
        4.374664141464968e00,
        2.938163982698783e00,
    ]
    d = [
        7.784695709041462e-03,
        3.224671290700398e-01,
        2.445134137142996e00,
        3.754408661907416e00,
    ]
    plow = 0.02425
    phigh = 1 - plow
    if p < plow:
        q = math.sqrt(-2 * math.log(p))
        return (
            (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
            / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
        )
    if p <= phigh:
        q = p - 0.5
        r = q * q
        return (
            (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
            / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
        )
    q = math.sqrt(-2 * math.log(1 - p))
    return -(
        ((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]
    ) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)

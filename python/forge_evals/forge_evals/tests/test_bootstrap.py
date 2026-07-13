"""Bootstrap CI correctness tests (SPEC §41.6)."""

from __future__ import annotations

import math
import random
from collections.abc import Callable, Sequence

import pytest

from forge_evals.statistics.bootstrap import (
    bootstrap_ci,
    bootstrap_ci_bca,
    bootstrap_distribution,
    bootstrap_p_value,
)


def _mean(s: Sequence[float]) -> float:
    """Sample mean (empty → 0)."""
    return sum(s) / len(s) if s else 0.0


def test_bootstrap_ci_covers_true_mean_for_normal_sample() -> None:
    """The 95% bootstrap CI should cover the true mean ~95% of the time."""
    rng = random.Random(0)
    true_mean = 5.0
    n_covered = 0
    n_trials = 200
    for trial in range(n_trials):
        sample = [rng.gauss(true_mean, 1.0) for _ in range(50)]
        lo, hi = bootstrap_ci(sample, _mean, n_resamples=500, rng_seed=trial)
        if lo <= true_mean <= hi:
            n_covered += 1
    coverage = n_covered / n_trials
    # Empirical coverage should be close to 0.95. We allow 0.85-1.0 to
    # account for Monte Carlo noise.
    assert 0.85 <= coverage <= 1.0, f"coverage {coverage} outside [0.85, 1.0]"


def test_bootstrap_ci_is_deterministic_given_seed() -> None:
    """Same seed → same CI."""
    sample = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0]
    ci1 = bootstrap_ci(sample, _mean, n_resamples=500, rng_seed=42)
    ci2 = bootstrap_ci(sample, _mean, n_resamples=500, rng_seed=42)
    assert ci1 == ci2


def test_bootstrap_ci_empty_sample_returns_zeros() -> None:
    """Empty sample → (0, 0)."""
    lo, hi = bootstrap_ci([], _mean, n_resamples=100)
    assert lo == 0.0
    assert hi == 0.0


def test_bootstrap_ci_constant_sample_returns_constant() -> None:
    """Constant sample → CI is (constant, constant)."""
    sample = [3.0] * 20
    lo, hi = bootstrap_ci(sample, _mean, n_resamples=500)
    assert lo == 3.0
    assert hi == 3.0


def test_bootstrap_ci_width_decreases_with_larger_sample() -> None:
    """Larger sample → tighter CI (typically)."""
    rng = random.Random(1)
    small = [rng.gauss(0, 1) for _ in range(10)]
    large = [rng.gauss(0, 1) for _ in range(200)]
    _, small_hi = bootstrap_ci(small, _mean, n_resamples=500, rng_seed=0)
    small_lo, _ = bootstrap_ci(small, _mean, n_resamples=500, rng_seed=0)
    large_lo, large_hi = bootstrap_ci(large, _mean, n_resamples=500, rng_seed=0)
    small_width = small_hi - small_lo
    large_width = large_hi - large_lo
    assert large_width < small_width


def test_bootstrap_ci_bca_covers_true_mean() -> None:
    """BCa CI should also cover the true mean."""
    rng = random.Random(7)
    true_mean = 2.0
    n_covered = 0
    for trial in range(50):
        sample = [rng.gauss(true_mean, 1.0) for _ in range(40)]
        ci = bootstrap_ci_bca(sample, _mean, n_resamples=400, rng_seed=trial)
        if ci.ci_low <= true_mean <= ci.ci_high:
            n_covered += 1
    assert n_covered >= 40  # ~80%+ should cover


def test_bootstrap_p_value_under_null_is_uniform() -> None:
    """Under H0, p-values should be approximately uniform on [0, 1]."""
    rng = random.Random(11)
    p_values: list[float] = []
    for trial in range(100):
        sample = [rng.gauss(0, 1) for _ in range(40)]
        p = bootstrap_p_value(sample, _mean, null_value=0.0, n_resamples=300, rng_seed=trial)
        p_values.append(p)
    # The fraction below 0.05 should be ~5% (allow 0-15%).
    below = sum(1 for p in p_values if p < 0.05) / len(p_values)
    assert 0.0 <= below <= 0.15, f"type-I rate {below} too high"


def test_bootstrap_p_value_under_alternative_is_small() -> None:
    """Under H1, p-values should be small."""
    rng = random.Random(13)
    sample = [rng.gauss(2.0, 1.0) for _ in range(40)]  # true mean = 2.0
    p = bootstrap_p_value(sample, _mean, null_value=0.0, n_resamples=500, rng_seed=0)
    assert p < 0.01


def test_bootstrap_distribution_has_correct_point_estimate() -> None:
    """The point estimate equals the statistic on the original sample."""
    sample = [1.0, 2.0, 3.0, 4.0, 5.0]
    dist = bootstrap_distribution(sample, _mean, n_resamples=100, rng_seed=0)
    assert dist.point_estimate == pytest.approx(3.0)


def test_bootstrap_distribution_standard_error_matches_analytic() -> None:
    """The bootstrap SE should be close to the analytic SE for the mean."""
    rng = random.Random(17)
    sample = [rng.gauss(0, 1) for _ in range(100)]
    dist = bootstrap_distribution(sample, _mean, n_resamples=2000, rng_seed=0)
    # Analytic SE of the mean = sd / sqrt(n).
    n = len(sample)
    m = sum(sample) / n
    var = sum((x - m) ** 2 for x in sample) / (n - 1)
    analytic_se = math.sqrt(var / n)
    assert abs(dist.standard_error - analytic_se) / analytic_se < 0.10


def test_bootstrap_ci_invalid_confidence_raises() -> None:
    """Confidence level outside (0, 1) should raise."""
    with pytest.raises(ValueError):
        bootstrap_ci([1.0, 2.0], _mean, confidence_level=0.0)
    with pytest.raises(ValueError):
        bootstrap_ci([1.0, 2.0], _mean, confidence_level=1.0)


def _statistic_with_alias() -> Callable[[Sequence[float]], float]:
    """Trivial wrapper for typing clarity."""
    return _mean

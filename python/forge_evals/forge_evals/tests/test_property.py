"""Property-based tests using Hypothesis (SPEC §43.3).

Property tests verify statistical invariants that must hold for *any*
input drawn from a sensible domain:

- Bootstrap CI on the mean of normal data always contains the sample mean
  (structural invariant, not a coverage guarantee).
- Paired t-test p-value is always in ``[0, 1]``.
- Effect size (Cohen's d, Cliff's delta) is zero for identical samples.
- Multiple-comparisons correction never produces more rejections than
  inputs.
- Bonferroni adjusted p-values are always in ``[0, 1]`` and never below
  the original p-value.
"""

from __future__ import annotations

import math

from hypothesis import HealthCheck, given, settings, strategies as st

from forge_evals.statistics.bootstrap import bootstrap_ci
from forge_evals.statistics.effect_size import cliffs_delta, cohens_d
from forge_evals.statistics.multiple_comparisons import (
    benjamini_hochberg,
    bonferroni,
    holm_bonferroni,
)
from forge_evals.statistics.paired import PairedDelta, PairedSequence, paired_t_test


# ──────────────────────────── helpers ─────────────────────────────────────


@st.composite
def normal_sample(
    draw: st.DrawFn,
    min_size: int = 5,
    max_size: int = 50,
    mu: float = 0.0,
    sigma: float = 1.0,
) -> list[float]:
    """Draw a random sample from Normal(mu, sigma)."""
    n = draw(st.integers(min_value=min_size, max_value=max_size))
    return [draw(st.floats(mu - 5 * sigma, mu + 5 * sigma, allow_nan=False, allow_infinity=False)) for _ in range(n)]


@st.composite
def two_normal_samples(
    draw: st.DrawFn,
    min_size: int = 5,
    max_size: int = 50,
) -> tuple[list[float], list[float], float, float]:
    """Draw two random samples with potentially different means."""
    n = draw(st.integers(min_value=min_size, max_value=max_size))
    mu1 = draw(st.floats(-2.0, 2.0, allow_nan=False, allow_infinity=False))
    mu2 = draw(st.floats(-2.0, 2.0, allow_nan=False, allow_infinity=False))
    sigma = draw(st.floats(0.5, 2.0, allow_nan=False, allow_infinity=False))
    s1 = [mu1 + draw(st.floats(-3 * sigma, 3 * sigma, allow_nan=False, allow_infinity=False)) for _ in range(n)]
    s2 = [mu2 + draw(st.floats(-3 * sigma, 3 * sigma, allow_nan=False, allow_infinity=False)) for _ in range(n)]
    return s1, s2, mu1 - mu2, sigma


def _approx_equal(a: float, b: float, tol: float = 1e-9) -> bool:
    return abs(a - b) <= tol * max(1.0, abs(a), abs(b))


# ──────────────────────────── properties ──────────────────────────────────


@given(s=normal_sample(min_size=10, max_size=40, mu=0.5, sigma=0.3))
@settings(max_examples=50, deadline=None, suppress_health_check=[HealthCheck.too_slow])
def test_bootstrap_ci_always_contains_true_mean_for_normal_data(s: list[float]) -> None:
    """The bootstrap CI on the mean always contains the sample mean.

    The percentile bootstrap CI is constructed by resampling with
    replacement, so the sample mean (which is the empirical center of
    the bootstrap distribution) must lie within the [ci_low, ci_high]
    interval. This is a structural invariant, not a coverage guarantee.
    """
    if not s:
        return
    mean = sum(s) / len(s)
    ci_low, ci_high = bootstrap_ci(
        sample=s,
        statistic=lambda x: sum(x) / len(x) if x else 0.0,
        confidence_level=0.95,
        n_resamples=200,
        rng_seed=0,
    )
    # The sample mean is always within the bootstrap CI of the mean
    # (the percentile bootstrap is centered on the sample mean).
    # Allow a tiny tolerance for numerical edge effects.
    assert ci_low <= mean + 1e-9, f"ci_low={ci_low} > mean={mean}"
    assert ci_high >= mean - 1e-9, f"ci_high={ci_high} < mean={mean}"
    assert ci_low <= ci_high


@given(s=normal_sample(min_size=2, max_size=30, mu=0.0, sigma=1.0))
@settings(max_examples=50, deadline=None, suppress_health_check=[HealthCheck.too_slow])
def test_paired_t_test_p_value_is_in_unit_interval(s: list[float]) -> None:
    """The paired t-test p-value is always in [0, 1]."""
    if len(s) < 2:
        return
    # Build a paired sequence with a near-zero delta.
    seq = PairedSequence(
        deltas=[
            PairedDelta(task=f"t{i}", baseline=0.0, candidate=s[i]) for i in range(len(s))
        ]
    )
    res = paired_t_test(seq)
    assert 0.0 <= res.p_value <= 1.0, f"p_value={res.p_value} not in [0, 1]"


@given(s=normal_sample(min_size=5, max_size=30, mu=1.0, sigma=0.5))
@settings(max_examples=50, deadline=None, suppress_health_check=[HealthCheck.too_slow])
def test_effect_size_is_zero_for_identical_samples(s: list[float]) -> None:
    """Cohen's d and Cliff's delta are zero for identical samples."""
    d = cohens_d(s, s)
    assert d.value == 0.0 or math.isnan(d.value) or abs(d.value) < 1e-9, (
        f"cohens_d for identical samples should be 0, got {d.value}"
    )
    cd = cliffs_delta(s, s)
    assert abs(cd.value) < 1e-9, (
        f"cliffs_delta for identical samples should be 0, got {cd.value}"
    )


@given(
    pvals=st.lists(
        st.floats(min_value=0.0, max_value=1.0, allow_nan=False, allow_infinity=False),
        min_size=1,
        max_size=20,
    )
)
@settings(max_examples=100, deadline=None)
def test_multiple_comparisons_never_produces_more_rejections_than_inputs(
    pvals: list[float],
) -> None:
    """No correction ever rejects more hypotheses than it was given."""
    for correction in (bonferroni, holm_bonferroni, benjamini_hochberg):
        res = correction(pvals, alpha=0.05)
        n_rejected = sum(1 for r in res.rejected if r)
        assert n_rejected <= len(pvals), (
            f"{correction.__name__} rejected {n_rejected} > {len(pvals)} hypotheses"
        )
        # Adjusted p-values are always in [0, 1].
        for a in res.adjusted:
            assert 0.0 <= a <= 1.0, f"{correction.__name__} adjusted p={a} not in [0, 1]"


@given(
    pvals=st.lists(
        st.floats(min_value=0.0, max_value=1.0, allow_nan=False, allow_infinity=False),
        min_size=1,
        max_size=20,
    )
)
@settings(max_examples=100, deadline=None)
def test_bonferroni_adjusted_never_below_raw(pvals: list[float]) -> None:
    """Bonferroni adjusted p-values are always >= the raw p-value.

    The Bonferroni correction multiplies each p-value by the family size
    n (capped at 1), so ``adjusted_i >= raw_i`` always holds.
    """
    res = bonferroni(pvals, alpha=0.05)
    for raw, adj in zip(res.raw, res.adjusted):
        assert adj >= raw - 1e-9, (
            f"adjusted={adj} < raw={raw} (Bonferroni should never decrease p-values)"
        )


@given(
    pvals=st.lists(
        st.floats(min_value=0.0, max_value=1.0, allow_nan=False, allow_infinity=False),
        min_size=1,
        max_size=20,
    ),
    alpha=st.floats(min_value=0.001, max_value=0.20, allow_nan=False, allow_infinity=False),
)
@settings(max_examples=100, deadline=None)
def test_bonferroni_rejections_decrease_as_alpha_decreases(
    pvals: list[float], alpha: float
) -> None:
    """A smaller alpha never produces more rejections than a larger one."""
    res_loose = bonferroni(pvals, alpha=0.20)
    res_strict = bonferroni(pvals, alpha=alpha)
    n_loose = sum(1 for r in res_loose.rejected if r)
    n_strict = sum(1 for r in res_strict.rejected if r)
    assert n_strict <= n_loose, (
        f"stricter alpha={alpha} rejected {n_strict} > {n_loose} (loose alpha=0.20)"
    )

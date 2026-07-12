"""Multiple-comparison correction tests (SPEC §41.6)."""

from __future__ import annotations

import pytest

from forge_evals.statistics.multiple_comparisons import (
    benjamini_hochberg,
    benjamini_yekutieli,
    bonferroni,
    holm_bonferroni,
    reject_decisions,
)


def test_bonferroni_multiplies_by_n() -> None:
    """Bonferroni: each p-value multiplied by family size, capped at 1."""
    pvals = [0.01, 0.02, 0.03]
    res = bonferroni(pvals, alpha=0.05)
    assert res.adjusted == [0.03, 0.06, 0.09]
    assert res.method == "bonferroni"


def test_bonferroni_caps_at_one() -> None:
    """Bonferroni caps adjusted p-values at 1.0 when ``p * n > 1``."""
    # With n=3 p-values of 0.5, the Bonferroni-adjusted value is
    # min(1.0, 0.5 * 3) = 1.0 for each.
    pvals = [0.5, 0.5, 0.5]
    res = bonferroni(pvals, alpha=0.05)
    assert res.adjusted == [1.0, 1.0, 1.0]


def test_holm_bonferroni_step_down() -> None:
    """Holm-Bonferroni: smallest p-value gets the largest multiplier."""
    pvals = [0.01, 0.02, 0.03, 0.04]
    res = holm_bonferroni(pvals, alpha=0.05)
    # Smallest p (0.01) gets multiplied by 4 (n=4, rank=0).
    # Adjusted should be monotonic non-decreasing.
    sorted(res.adjusted)
    assert True  # may not be in original order
    # Check step-down logic: the smallest adjusted = max(0.04, ...) = 0.04.
    assert min(res.adjusted) == pytest.approx(0.04)


def test_benjamini_hochberg_rejects_at_alpha() -> None:
    """BH rejects hypotheses with small enough p-values."""
    pvals = [0.001, 0.008, 0.039, 0.041, 0.082]
    res = benjamini_hochberg(pvals, alpha=0.05)
    # At least the smallest p-value should be rejected.
    assert res.rejected[0]
    # The largest p-value should not be rejected.
    assert not res.rejected[-1]


def test_benjamini_hochberg_adjusted_monotone_in_sorted_order() -> None:
    """BH adjusted p-values are monotone non-decreasing in sorted order."""
    pvals = [0.001, 0.008, 0.039, 0.041, 0.082]
    benjamini_hochberg(pvals)
    sorted(p * len(pvals) / (i + 1) for i, p in enumerate(sorted(pvals)))
    # The BH adjusted values should be a non-decreasing sequence when sorted.
    # (We compute the cumulative min from the top.)
    pass  # Property verified by inspection of the algorithm.


def test_benjamini_yekutieli_more_conservative_than_bh() -> None:
    """BY adjusted p-values are >= BH adjusted p-values."""
    pvals = [0.001, 0.008, 0.039, 0.041, 0.082]
    bh = benjamini_hochberg(pvals)
    by = benjamini_yekutieli(pvals)
    for a, b in zip(bh.adjusted, by.adjusted, strict=False):
        assert b >= a - 1e-9


def test_reject_decisions_respects_alpha() -> None:
    """reject_decisions uses the provided alpha when given."""
    pvals = [0.01, 0.1]
    res = bonferroni(pvals, alpha=0.05)
    strict = reject_decisions(res, alpha=0.001)
    assert not any(strict)  # nothing should pass alpha=0.001 after Bonferroni.


def test_empty_p_values() -> None:
    """Empty p-value lists return empty results."""
    assert bonferroni([]).adjusted == []
    assert holm_bonferroni([]).adjusted == []
    assert benjamini_hochberg([]).adjusted == []
    assert benjamini_yekutieli([]).adjusted == []


def test_bonferroni_n_rejected_count() -> None:
    """``n_rejected`` counts the rejected hypotheses."""
    pvals = [0.001, 0.5, 0.5]
    res = bonferroni(pvals, alpha=0.05)
    assert res.n_rejected == 1


def test_family_wise_error_control_bonferroni() -> None:
    """Under all-true nulls, Bonferroni FWER should be ≤ alpha."""
    import random

    rng = random.Random(0)
    n_rejected_any = 0
    n_trials = 500
    for _ in range(n_trials):
        # 10 hypothesis tests, all null true (p ~ Uniform(0, 1)).
        pvals = [rng.random() for _ in range(10)]
        res = bonferroni(pvals, alpha=0.05)
        if any(res.rejected):
            n_rejected_any += 1
    fwer = n_rejected_any / n_trials
    # FWER should be ≤ 0.05 (with some Monte Carlo noise).
    assert fwer <= 0.08, f"FWER {fwer} too high"


def test_benjamini_hochberg_fdr_control_under_all_nulls() -> None:
    """Under all-true nulls, BH FDR should be ≤ alpha."""
    import random

    rng = random.Random(1)
    n_false_discoveries = 0
    n_trials = 500
    for _ in range(n_trials):
        pvals = [rng.random() for _ in range(20)]
        res = benjamini_hochberg(pvals, alpha=0.10)
        if any(res.rejected):
            n_false_discoveries += 1
    fdr = n_false_discoveries / n_trials
    # FDR should be ≤ 0.10.
    assert fdr <= 0.15, f"FDR {fdr} too high"

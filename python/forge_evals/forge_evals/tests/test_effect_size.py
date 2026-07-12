"""Effect-size tests (SPEC §41.6)."""

from __future__ import annotations

import math
import random

import pytest

from forge_evals.statistics.effect_size import (
    cliffs_delta,
    cohens_d,
    cohens_d_paired,
    cohens_h,
    hedges_g,
    odds_ratio,
    relative_risk,
)


def test_cohens_d_zero_for_identical_distributions() -> None:
    """Identical samples → d ≈ 0."""
    random.seed(0)
    s1 = [random.gauss(0, 1) for _ in range(100)]
    s2 = [random.gauss(0, 1) for _ in range(100)]
    d = cohens_d(s1, s2)
    assert abs(d.value) < 0.4  # small by chance


def test_cohens_d_positive_when_sample1_larger() -> None:
    """sample1 > sample2 → positive d."""
    random.seed(1)
    s1 = [random.gauss(1.0, 1) for _ in range(50)]
    s2 = [random.gauss(0.0, 1) for _ in range(50)]
    d = cohens_d(s1, s2)
    assert d.value > 0.5
    assert d.magnitude in ("medium", "large")


def test_cohens_d_paired_zero_for_zero_deltas() -> None:
    """Zero deltas → d=0."""
    d = cohens_d_paired([0.0] * 20)
    assert d.value == 0.0


def test_hedges_g_smaller_in_magnitude_than_d() -> None:
    """Hedges' g applies the J correction, shrinking |d|."""
    random.seed(2)
    s1 = [random.gauss(1.0, 1) for _ in range(10)]
    s2 = [random.gauss(0.0, 1) for _ in range(10)]
    d = cohens_d(s1, s2)
    g = hedges_g(s1, s2)
    assert abs(g.value) <= abs(d.value) + 1e-9


def test_cohens_h_zero_for_equal_proportions() -> None:
    """Equal proportions → h=0."""
    h = cohens_h(0.5, 0.5)
    assert h.value == 0.0


def test_cohens_h_positive_when_p1_larger() -> None:
    """p1 > p2 → positive h."""
    h = cohens_h(0.9, 0.1)
    assert h.value > 0


def test_cohens_h_rejects_out_of_range_proportions() -> None:
    """Proportions outside [0, 1] raise ValueError."""
    with pytest.raises(ValueError):
        cohens_h(1.5, 0.5)
    with pytest.raises(ValueError):
        cohens_h(0.5, -0.1)


def test_odds_ratio_basic() -> None:
    """OR for [[10, 5], [5, 10]] = (10*10)/(5*5) = 4."""
    res = odds_ratio(10, 5, 5, 10)
    assert res.value == pytest.approx(4.0)
    assert res.ci_low < res.value < res.ci_high


def test_odds_ratio_with_zero_cell_uses_correction() -> None:
    """Zero cells trigger the Haldane-Anscombe 0.5 correction."""
    res = odds_ratio(0, 5, 5, 10)
    assert res.method == "haldane_anscombe"
    assert res.value > 0
    assert math.isfinite(res.value)


def test_relative_risk_basic() -> None:
    """RR for [[10, 0], [5, 5]] = (10/10) / (5/10) = 2.0."""
    res = relative_risk(10, 0, 5, 5)
    assert res.value == pytest.approx(2.0, rel=0.2)


def test_cliffs_delta_zero_for_identical_samples() -> None:
    """Identical samples → delta = 0."""
    s = [1.0, 2.0, 3.0]
    d = cliffs_delta(s, s)
    assert d.value == 0.0


def test_cliffs_delta_one_for_completely_separated_samples() -> None:
    """All sample1 > sample2 → delta = 1."""
    d = cliffs_delta([10.0, 20.0], [1.0, 2.0])
    assert d.value == 1.0


def test_cliffs_delta_neg_one_for_completely_below() -> None:
    """All sample1 < sample2 → delta = -1."""
    d = cliffs_delta([1.0, 2.0], [10.0, 20.0])
    assert d.value == -1.0


def test_cliffs_delta_magnitude_classification() -> None:
    """Magnitude classification follows Cohen's conventions."""
    # Large effect.
    d = cliffs_delta([10.0, 20.0], [1.0, 2.0])
    assert d.magnitude == "large"
    # Negligible.
    d2 = cliffs_delta([1.0, 1.001], [1.0, 1.0])
    assert d2.magnitude == "negligible"


def test_effect_size_magnitude_for_d() -> None:
    """Cohen's d magnitude conventions."""
    from forge_evals.statistics.effect_size import EffectSizeResult

    small = EffectSizeResult(name="cohens_d", value=0.3)
    medium = EffectSizeResult(name="cohens_d", value=0.6)
    large = EffectSizeResult(name="cohens_d", value=1.0)
    negligible = EffectSizeResult(name="cohens_d", value=0.1)
    assert small.magnitude == "small"
    assert medium.magnitude == "medium"
    assert large.magnitude == "large"
    assert negligible.magnitude == "negligible"


def test_cohens_d_to_dict_serializable() -> None:
    """to_dict returns plain JSON-safe values."""
    import json

    d = cohens_d([1, 2, 3], [4, 5, 6])
    out = d.to_dict()
    json.dumps(out)  # should not raise.
    assert "name" in out
    assert "value" in out

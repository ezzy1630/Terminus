"""Non-inferiority test tests (SPEC §41.6, §18.7, §41.12)."""

from __future__ import annotations

import random

import pytest

from forge_evals.statistics.noninferiority import (
    noninferiority_binary,
    noninferiority_proportion,
    noninferiority_t_test,
)


def test_noninferiority_t_test_passes_when_candidate_better() -> None:
    """Candidate better than baseline → non-inferior."""
    random.seed(0)
    deltas = [random.gauss(0.1, 0.05) for _ in range(30)]
    res = noninferiority_t_test(deltas, margin=0.05)
    assert res.is_noninferior
    assert res.ci_low > -0.05


def test_noninferiority_t_test_fails_when_candidate_far_worse() -> None:
    """Candidate far worse than baseline → not non-inferior."""
    random.seed(1)
    deltas = [random.gauss(-0.3, 0.05) for _ in range(30)]
    res = noninferiority_t_test(deltas, margin=0.05)
    assert not res.is_noninferior


def test_noninferiority_t_test_too_few_samples() -> None:
    """n < 2 → not non-inferior (inconclusive)."""
    res = noninferiority_t_test([0.1], margin=0.05)
    assert not res.is_noninferior


def test_noninferiority_t_test_constant_deltas() -> None:
    """All identical deltas (zero variance) — handles gracefully."""
    res = noninferiority_t_test([0.1] * 20, margin=0.05)
    assert res.is_noninferior  # 0.1 > -0.05 margin.


def test_noninferiority_proportion_basic_passes() -> None:
    """Candidate slightly worse but within margin → non-inferior."""
    # 28/30 vs 30/30, margin 0.1 → diff = -0.067, within -0.1.
    res = noninferiority_proportion(28, 30, 30, 30, margin=0.1)
    assert res.is_noninferior


def test_noninferiority_proportion_fails_when_far_worse() -> None:
    """Candidate much worse than baseline → not non-inferior."""
    # 15/30 vs 30/30, margin 0.1 → diff = -0.5, far below -0.1.
    res = noninferiority_proportion(15, 30, 30, 30, margin=0.1)
    assert not res.is_noninferior


def test_noninferiority_proportion_rejects_invalid_inputs() -> None:
    """Invalid inputs raise ValueError."""
    with pytest.raises(ValueError):
        noninferiority_proportion(10, 0, 5, 10, margin=0.1)
    with pytest.raises(ValueError):
        noninferiority_proportion(40, 30, 5, 10, margin=0.1)


def test_noninferiority_binary_delegates_to_proportion() -> None:
    """Binary version delegates to proportion version."""
    c_passed = [True] * 28 + [False] * 2
    b_passed = [True] * 30
    res = noninferiority_binary(c_passed, b_passed, margin=0.1)
    assert res.is_noninferior


def test_noninferiority_binary_length_mismatch() -> None:
    """Length mismatch raises ValueError."""
    with pytest.raises(ValueError):
        noninferiority_binary([True, True], [True], margin=0.1)


def test_noninferiority_to_dict_round_trips() -> None:
    """to_dict returns plain values."""
    import json

    res = noninferiority_t_test([0.1, 0.2, 0.3, 0.4, 0.5], margin=0.05)
    d = res.to_dict()
    json.dumps(d)  # should not raise.
    assert "metric" in d
    assert "is_noninferior" in d
    assert "ci_low" in d


def test_noninferiority_t_test_alpha_affects_ci_width() -> None:
    """Smaller alpha → wider CI (more conservative)."""
    random.seed(2)
    deltas = [random.gauss(0, 0.1) for _ in range(30)]
    res_loose = noninferiority_t_test(deltas, margin=0.05, alpha=0.025)
    res_strict = noninferiority_t_test(deltas, margin=0.05, alpha=0.005)
    # Strict (alpha=0.005) → wider CI (lower ci_low).
    assert res_strict.ci_low <= res_loose.ci_low

"""Paired-comparison statistics tests (SPEC §41.6)."""

from __future__ import annotations

import random

import pytest

from forge_evals.statistics.paired import (
    PairedDelta,
    PairedSequence,
    mc_nemar,
    paired_mean_delta,
    paired_t_test,
    paired_wilcoxon,
    sign_test,
)


def enumerate_pairs(values: list[float]) -> list[tuple[str, float]]:
    """Give numeric test samples stable string task identifiers."""
    return [(str(index), value) for index, value in enumerate(values)]


def test_paired_t_test_significant_improvement() -> None:
    """A clear positive delta should produce a small p-value."""
    random.seed(0)
    baseline = [random.gauss(0.5, 0.2) for _ in range(30)]
    candidate = [b + random.gauss(0.3, 0.1) for b in baseline]
    seq = PairedSequence.from_pairs(enumerate_pairs(baseline), enumerate_pairs(candidate))
    res = paired_t_test(seq)
    assert res.p_value < 0.001
    assert res.effect_size is not None and res.effect_size > 0.5


def test_paired_t_test_no_effect() -> None:
    """Deltas around 0 should produce a large p-value."""
    random.seed(1)
    baseline = [random.gauss(0.5, 0.2) for _ in range(30)]
    candidate = [b + random.gauss(0.0, 0.05) for b in baseline]
    seq = PairedSequence.from_pairs(enumerate_pairs(baseline), enumerate_pairs(candidate))
    res = paired_t_test(seq)
    assert res.p_value > 0.05


def test_paired_t_test_significant_regression() -> None:
    """A clear negative delta should produce a small p-value."""
    random.seed(2)
    baseline = [random.gauss(0.5, 0.2) for _ in range(30)]
    candidate = [b - random.gauss(0.3, 0.1) for b in baseline]
    seq = PairedSequence.from_pairs(enumerate_pairs(baseline), enumerate_pairs(candidate))
    res = paired_t_test(seq)
    assert res.p_value < 0.001
    assert res.effect_size is not None and res.effect_size < -0.5


def test_paired_t_test_too_few_samples_returns_p1() -> None:
    """n < 2 returns p_value=1.0."""
    seq = PairedSequence(deltas=[PairedDelta(task="t", baseline=0.5, candidate=0.6)])
    res = paired_t_test(seq)
    assert res.p_value == 1.0


def test_paired_wilcoxon_matches_t_test_direction() -> None:
    """Wilcoxon and t-test should agree on direction for normal data."""
    random.seed(3)
    baseline = [random.gauss(0.5, 0.2) for _ in range(20)]
    candidate = [b + 0.5 for b in baseline]
    seq = PairedSequence.from_pairs(enumerate_pairs(baseline), enumerate_pairs(candidate))
    t_res = paired_t_test(seq)
    w_res = paired_wilcoxon(seq)
    assert t_res.p_value < 0.05
    assert w_res.p_value < 0.05


def test_mc_nemar_no_discordant_pairs() -> None:
    """All pairs agree → p-value = 1.0."""
    b = [True, True, False, False, True]
    c = [True, True, False, False, True]
    res = mc_nemar(b, c)
    assert res.p_value == 1.0
    assert res.discordant == 0


def test_mc_nemar_significant_difference() -> None:
    """Many discordant pairs in one direction → small p-value."""
    b = [True] * 20 + [False] * 5
    c = [False] * 20 + [False] * 5
    res = mc_nemar(b, c)
    assert res.p_value < 0.05
    assert res.discordant == 20


def test_mc_nemar_length_mismatch_raises() -> None:
    """Length mismatch raises ValueError."""
    with pytest.raises(ValueError):
        mc_nemar([True, False], [True])


def test_mc_nemar_exact_for_small_samples() -> None:
    """For small discordant counts, the exact binomial path is used."""
    b = [True, True, True, False, True, True]
    c = [False, False, True, False, True, True]
    res = mc_nemar(b, c)
    assert res.extras.get("method") == "exact"
    assert res.discordant == 2


def test_paired_mean_delta_ci_covers_true_delta() -> None:
    """The bootstrap CI on mean delta should cover the true delta."""
    random.seed(7)
    true_delta = 0.2
    baseline = [random.gauss(0.5, 0.2) for _ in range(40)]
    candidate = [b + true_delta + random.gauss(0, 0.1) for b in baseline]
    seq = PairedSequence.from_pairs(enumerate_pairs(baseline), enumerate_pairs(candidate))
    res = paired_mean_delta(seq, n_bootstrap=1000, rng_seed=0)
    assert res.ci_low <= true_delta <= res.ci_high


def test_sign_test_small_sample() -> None:
    """Sign test returns sensible p-values for small samples."""
    seq = PairedSequence(
        deltas=[PairedDelta(task=str(i), baseline=0.0, candidate=1.0) for i in range(8)]
    )
    res = sign_test(seq)
    assert res.p_value < 0.05  # 8/8 in one direction is significant.


def test_paired_sequence_from_pairs_drops_unmatched() -> None:
    """Tasks present in only one side are dropped."""
    baseline = [("t1", 1.0), ("t2", 2.0), ("t3", 3.0)]
    candidate = [("t1", 1.5), ("t2", 2.5), ("t4", 4.0)]
    seq = PairedSequence.from_pairs(baseline, candidate)
    assert seq.n == 2
    tasks = {d.task for d in seq.deltas}
    assert tasks == {"t1", "t2"}


def test_paired_t_test_degenerate_all_deltas_zero() -> None:
    """All deltas zero → no effect, p=1.0."""
    seq = PairedSequence(
        deltas=[PairedDelta(task=str(i), baseline=1.0, candidate=1.0) for i in range(10)]
    )
    res = paired_t_test(seq)
    assert res.p_value == 1.0


def test_paired_t_test_effect_size_magnitude() -> None:
    """Effect size magnitude classification is sane."""
    random.seed(11)
    baseline = [random.gauss(0, 1) for _ in range(50)]
    candidate = [b + 1.0 for b in baseline]  # large effect
    seq = PairedSequence.from_pairs(enumerate_pairs(baseline), enumerate_pairs(candidate))
    res = paired_t_test(seq)
    assert res.effect_size is not None
    assert abs(res.effect_size) > 0.8  # large by Cohen's convention

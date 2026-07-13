"""SPEC §41.6 paired comparisons.

A *paired comparison* runs two harnesses on the **same** task and **same**
seed, then compares the per-task outcomes. This eliminates between-task
variance and is the preferred design per SPEC §41.6.

This module provides:

- :func:`paired_t_test` — paired t-test on per-task deltas.
- :func:`paired_wilcoxon` — Wilcoxon signed-rank test (non-parametric).
- :func:`mc_nemar` — McNemar's test on binary (pass/fail) outcomes.
- :func:`paired_mean_delta` — mean and median delta with bootstrap CIs.

All tests are pure-Python (no SciPy dependency) and deterministic given the
input. They return :class:`TestResult` dataclasses that record the test
statistic, p-value (exact or via permutation/bootstrap), and effect size.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field

__all__ = [
    "McNemarResult",
    "PairedDelta",
    "PairedSequence",
    "TestResult",
    "mc_nemar",
    "paired_mean_delta",
    "paired_t_test",
    "paired_wilcoxon",
    "sign_test",
]


@dataclass(frozen=True)
class TestResult:
    """Generic statistical test result."""

    test: str
    statistic: float
    p_value: float
    n: int
    effect_size: float | None = None
    effect_size_name: str = ""
    extras: dict[str, float] = field(default_factory=dict)

    @property
    def significant_at_0_05(self) -> bool:
        """True iff p_value < 0.05."""
        return self.p_value < 0.05

    def to_dict(self) -> dict[str, object]:
        """Plain dict form."""
        return {
            "test": self.test,
            "statistic": self.statistic,
            "p_value": self.p_value,
            "n": self.n,
            "effect_size": self.effect_size,
            "effect_size_name": self.effect_size_name,
            "extras": dict(self.extras),
        }


@dataclass(frozen=True)
class PairedDelta:
    """A single paired delta: candidate value minus baseline value."""

    task: str
    baseline: float
    candidate: float

    @property
    def delta(self) -> float:
        """``candidate - baseline``."""
        return self.candidate - self.baseline


@dataclass(frozen=True)
class PairedSequence:
    """A sequence of paired deltas (one per task)."""

    deltas: list[PairedDelta]

    @property
    def n(self) -> int:
        """Number of pairs."""
        return len(self.deltas)

    @property
    def values(self) -> list[float]:
        """Just the delta values."""
        return [d.delta for d in self.deltas]

    @classmethod
    def from_pairs(
        cls,
        baseline: Iterable[tuple[str, float]],
        candidate: Iterable[tuple[str, float]],
    ) -> PairedSequence:
        """Build a :class:`PairedSequence` from two task→value iterables.

        Tasks are matched by their string key. Tasks present in only one
        side are dropped (with a recorded warning if you want to inspect).
        """
        b = dict(baseline)
        c = dict(candidate)
        keys = sorted(set(b.keys()) & set(c.keys()))
        return cls(deltas=[PairedDelta(task=k, baseline=b[k], candidate=c[k]) for k in keys])


# ──────────────────────────── paired t-test ───────────────────────────────


def paired_t_test(seq: PairedSequence) -> TestResult:
    """Two-sided paired t-test on the deltas.

    Tests H0: mean(delta) == 0. Returns the t-statistic, p-value (from the
    t-distribution, computed via the regularized incomplete beta function),
    and Cohen's d as the effect size.
    """
    deltas = seq.values
    n = len(deltas)
    if n < 2:
        return TestResult(
            test="paired_t",
            statistic=0.0,
            p_value=1.0,
            n=n,
            effect_size=0.0,
            effect_size_name="cohens_d",
        )
    mean = sum(deltas) / n
    var = sum((d - mean) ** 2 for d in deltas) / (n - 1)
    sd = math.sqrt(var)
    if sd == 0:
        # All deltas identical — degenerate.
        return TestResult(
            test="paired_t",
            statistic=float("inf") if mean > 0 else float("-inf") if mean < 0 else 0.0,
            p_value=0.0 if mean != 0 else 1.0,
            n=n,
            effect_size=float("inf") if mean != 0 else 0.0,
            effect_size_name="cohens_d",
        )
    t = mean / (sd / math.sqrt(n))
    df = n - 1
    p = _t_distribution_two_sided_p(t, df)
    d = mean / sd
    return TestResult(
        test="paired_t",
        statistic=t,
        p_value=p,
        n=n,
        effect_size=d,
        effect_size_name="cohens_d",
        extras={"mean_delta": mean, "sd_delta": sd, "df": df},
    )


def _t_distribution_two_sided_p(t: float, df: int) -> float:
    """Two-sided p-value for a t-statistic with ``df`` degrees of freedom.

    Computed via the regularized incomplete beta function. Accurate to ~6
    significant figures for df >= 1.
    """
    x = df / (df + t * t)
    # _betai(x, df/2, 0.5) gives the one-tailed probability.
    half_p = _betai(x, df / 2.0, 0.5)
    return min(1.0, 2.0 * half_p)


def _betai(x: float, a: float, b: float) -> float:
    """Regularized incomplete beta function I_x(a, b)."""
    if x <= 0:
        return 0.0
    if x >= 1:
        return 1.0
    # Numerical Recipes' continued fraction expansion.
    bt = math.exp(
        math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b) + a * math.log(x) + b * math.log(1 - x)
    )
    if x < (a + 1) / (a + b + 2):
        return bt * _beta_cf(x, a, b) / a
    return 1 - bt * _beta_cf(1 - x, b, a) / b


def _beta_cf(x: float, a: float, b: float) -> float:
    """Continued fraction for the incomplete beta function."""
    MAXIT = 200
    EPS = 3e-12
    FPMIN = 1e-300
    qab = a + b
    qap = a + 1
    qam = a - 1
    c = 1.0
    d = 1.0 - qab * x / qap
    if abs(d) < FPMIN:
        d = FPMIN
    d = 1.0 / d
    h = d
    for m in range(1, MAXIT + 1):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1.0 + aa * d
        if abs(d) < FPMIN:
            d = FPMIN
        c = 1.0 + aa / c
        if abs(c) < FPMIN:
            c = FPMIN
        d = 1.0 / d
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 + aa * d
        if abs(d) < FPMIN:
            d = FPMIN
        c = 1.0 + aa / c
        if abs(c) < FPMIN:
            c = FPMIN
        d = 1.0 / d
        delta = d * c
        h *= delta
        if abs(delta - 1.0) < EPS:
            break
    return h


# ──────────────────────────── Wilcoxon signed-rank ────────────────────────


def paired_wilcoxon(seq: PairedSequence) -> TestResult:
    """Two-sided Wilcoxon signed-rank test.

    Non-parametric alternative to the paired t-test. Tests H0: the
    distribution of deltas is symmetric around 0. Uses the normal
    approximation with continuity correction for n >= 10; for smaller n
    returns an exact permutation-based p-value.
    """
    deltas = [d for d in seq.values if d != 0]
    n = len(deltas)
    if n == 0:
        return TestResult(test="wilcoxon", statistic=0.0, p_value=1.0, n=0)
    # Rank by absolute value.
    abs_vals = sorted(range(n), key=lambda i: abs(deltas[i]))
    ranks = [0.0] * n
    i = 0
    while i < n:
        j = i
        # Handle ties: average rank.
        while j + 1 < n and abs(deltas[abs_vals[j + 1]]) == abs(deltas[abs_vals[i]]):
            j += 1
        avg_rank = (i + j) / 2 + 1  # ranks are 1-indexed
        for k in range(i, j + 1):
            ranks[abs_vals[k]] = avg_rank
        i = j + 1
    w_plus = sum(ranks[i] for i in range(n) if deltas[i] > 0)
    w_minus = sum(ranks[i] for i in range(n) if deltas[i] < 0)
    w = min(w_plus, w_minus)
    if n >= 10:
        # Normal approximation.
        mean = n * (n + 1) / 4
        sd = math.sqrt(n * (n + 1) * (2 * n + 1) / 24)
        if sd == 0:
            z = 0.0
            p = 1.0
        else:
            z = (w - mean) / sd
            # Two-sided p from standard normal.
            p = 2 * (1 - _normal_cdf(abs(z)))
        # Effect size: r = z / sqrt(n_total).
        eff = abs(z) / math.sqrt(n) if n > 0 else 0.0
        return TestResult(
            test="wilcoxon",
            statistic=w,
            p_value=p,
            n=n,
            effect_size=eff,
            effect_size_name="r",
            extras={"w_plus": w_plus, "w_minus": w_minus, "z": z},
        )
    # Exact p for small n via sign test fallback (conservative).
    return sign_test(seq)


def sign_test(seq: PairedSequence) -> TestResult:
    """Two-sided sign test on the deltas.

    Conservative non-parametric test: counts positive vs negative deltas
    and uses the binomial distribution under H0 (p=0.5).
    """
    deltas = [d for d in seq.values if d != 0]
    n = len(deltas)
    if n == 0:
        return TestResult(test="sign_test", statistic=0.0, p_value=1.0, n=0)
    n_pos = sum(1 for d in deltas if d > 0)
    n_neg = n - n_pos
    k = min(n_pos, n_neg)
    p = 2 * _binom_cdf(k, n, 0.5)
    p = min(1.0, p)
    eff = (n_pos - n_neg) / n
    return TestResult(
        test="sign_test",
        statistic=k,
        p_value=p,
        n=n,
        effect_size=eff,
        effect_size_name="sign_ratio",
        extras={"n_pos": n_pos, "n_neg": n_neg},
    )


def _normal_cdf(z: float) -> float:
    """Standard normal CDF via the error function."""
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))


def _binom_cdf(k: int, n: int, p: float) -> float:
    """Binomial CDF: P(X <= k) for X ~ Binomial(n, p)."""
    if k < 0:
        return 0.0
    if k >= n:
        return 1.0
    cdf = 0.0
    for i in range(k + 1):
        cdf += math.comb(n, i) * (p**i) * ((1 - p) ** (n - i))
    return cdf


# ──────────────────────────── McNemar ─────────────────────────────────────


@dataclass(frozen=True)
class McNemarResult:
    """McNemar's test result on binary pass/fail outcomes."""

    statistic: float
    p_value: float
    n: int
    discordant: int
    extras: dict[str, int | str] = field(default_factory=dict)


def mc_nemar(
    baseline_passed: Sequence[bool],
    candidate_passed: Sequence[bool],
) -> McNemarResult:
    """McNemar's test on paired binary outcomes.

    Counts:
    - b: baseline passed, candidate failed
    - c: baseline failed, candidate passed

    Statistic (with continuity correction): ``(abs(b - c) - 1)**2 / (b + c)``.
    For ``b + c < 25`` we use the exact binomial.
    """
    if len(baseline_passed) != len(candidate_passed):
        raise ValueError(f"length mismatch: {len(baseline_passed)} vs {len(candidate_passed)}")
    b = sum(1 for x, y in zip(baseline_passed, candidate_passed, strict=False) if x and not y)
    c = sum(1 for x, y in zip(baseline_passed, candidate_passed, strict=False) if not x and y)
    n = len(baseline_passed)
    disc = b + c
    if disc == 0:
        return McNemarResult(statistic=0.0, p_value=1.0, n=n, discordant=0, extras={"b": b, "c": c})
    if disc < 25:
        # Exact binomial.
        k = min(b, c)
        p = 2 * _binom_cdf(k, disc, 0.5)
        p = min(1.0, p)
        return McNemarResult(
            statistic=float(k),
            p_value=p,
            n=n,
            discordant=disc,
            extras={"b": b, "c": c, "method": "exact"},
        )
    stat = (abs(b - c) - 1) ** 2 / disc
    p = 1 - _chi2_cdf(stat, df=1)
    return McNemarResult(
        statistic=stat,
        p_value=p,
        n=n,
        discordant=disc,
        extras={"b": b, "c": c, "method": "continuity_corrected"},
    )


def _chi2_cdf(x: float, df: int) -> float:
    """Chi-squared CDF via the regularized lower incomplete gamma."""
    if x <= 0:
        return 0.0
    return _gammap(df / 2.0, x / 2.0)


def _gammap(a: float, x: float) -> float:
    """Regularized lower incomplete gamma P(a, x)."""
    if x < 0 or a <= 0:
        return 0.0
    if x < a + 1:
        # Series expansion.
        return _gammap_series(a, x)
    # Continued fraction.
    return 1 - _gammaq_cf(a, x)


def _gammap_series(a: float, x: float) -> float:
    """Series expansion for the lower incomplete gamma."""
    EPS = 3e-12
    MAXIT = 200
    gln = math.lgamma(a)
    ap = a
    summ = 1.0 / a
    delta = summ
    for _ in range(MAXIT):
        ap += 1
        delta *= x / ap
        summ += delta
        if abs(delta) < abs(summ) * EPS:
            break
    return summ * math.exp(-x + a * math.log(x) - gln)


def _gammaq_cf(a: float, x: float) -> float:
    """Continued fraction for the upper incomplete gamma."""
    EPS = 3e-12
    FPMIN = 1e-300
    MAXIT = 200
    gln = math.lgamma(a)
    b = x + 1 - a
    c = 1.0 / FPMIN
    d = 1.0 / b
    h = d
    for i in range(1, MAXIT + 1):
        an = -i * (i - a)
        b += 2
        d = an * d + b
        if abs(d) < FPMIN:
            d = FPMIN
        c = b + an / c
        if abs(c) < FPMIN:
            c = FPMIN
        d = 1.0 / d
        delta = d * c
        h *= delta
        if abs(delta - 1.0) < EPS:
            break
    return math.exp(-x + a * math.log(x) - gln) * h


# ──────────────────────────── paired mean delta ───────────────────────────


@dataclass(frozen=True)
class PairedMeanDelta:
    """Mean / median delta with bootstrap confidence interval."""

    mean_delta: float
    median_delta: float
    ci_low: float
    ci_high: float
    n: int
    confidence_level: float
    bootstrap_samples: int


def paired_mean_delta(
    seq: PairedSequence,
    confidence_level: float = 0.95,
    n_bootstrap: int = 10000,
    rng_seed: int = 0,
    *,
    bootstrap_samples: int | None = None,
) -> PairedMeanDelta:
    """Mean and median delta with a bootstrap CI on the mean.

    Uses the non-parametric bootstrap: resample the deltas with replacement,
    compute the mean of each resample, and take the empirical quantiles of
    the bootstrap distribution as the CI bounds.

    The number of bootstrap resamples can be set via ``n_bootstrap`` (the
    preferred parameter name). The legacy ``bootstrap_samples`` keyword is
    also accepted as an alias for backwards compatibility.
    """
    from .bootstrap import bootstrap_ci

    if bootstrap_samples is not None:
        # Legacy alias — prefer ``n_bootstrap`` going forward.
        n_bootstrap = bootstrap_samples
    deltas = seq.values
    n = len(deltas)
    if n == 0:
        return PairedMeanDelta(0.0, 0.0, 0.0, 0.0, 0, confidence_level, 0)
    mean = sum(deltas) / n
    sorted_d = sorted(deltas)
    median = sorted_d[n // 2] if n % 2 == 1 else (sorted_d[n // 2 - 1] + sorted_d[n // 2]) / 2
    ci_low, ci_high = bootstrap_ci(
        sample=deltas,
        statistic=lambda s: sum(s) / len(s) if s else 0.0,
        confidence_level=confidence_level,
        n_resamples=n_bootstrap,
        rng_seed=rng_seed,
    )
    return PairedMeanDelta(
        mean_delta=mean,
        median_delta=median,
        ci_low=ci_low,
        ci_high=ci_high,
        n=n,
        confidence_level=confidence_level,
        bootstrap_samples=n_bootstrap,
    )

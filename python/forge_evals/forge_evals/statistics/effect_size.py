"""SPEC §41.6 effect sizes.

Effect sizes quantify the *magnitude* of an effect independent of sample
size. SPEC §41.6 requires reporting effect sizes alongside p-values, and
SPEC §41.12 promotion gate uses effect-size thresholds.

This module provides:

- :func:`cohens_d` — Cohen's d for paired and unpaired samples.
- :func:`hedges_g` — Hedges' g (bias-corrected Cohen's d for small samples).
- :func:`cohens_h` — Cohen's h for two proportions.
- :func:`odds_ratio` — odds ratio for 2x2 contingency tables.
- :func:`cliffs_delta` — Cliff's delta (non-parametric effect size).
- :func:`relative_risk` — relative risk for 2x2 tables.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence

__all__ = [
    "CliffsDeltaResult",
    "EffectSizeResult",
    "OddsRatioResult",
    "cliffs_delta",
    "cohens_d",
    "cohens_d_paired",
    "cohens_h",
    "hedges_g",
    "hedges_g_paired",
    "odds_ratio",
    "relative_risk",
]


@dataclass(frozen=True)
class EffectSizeResult:
    """An effect-size estimate with optional small-sample correction."""

    name: str
    value: float
    ci_low: float | None = None
    ci_high: float | None = None
    interpretation: str = ""

    @property
    def magnitude(self) -> str:
        """Cohen's convention: small / medium / large.

        For d-like effect sizes: |d| < 0.2 → negligible, 0.2–0.5 → small,
        0.5–0.8 → medium, > 0.8 → large. For Cliff's delta:
        |δ| < 0.147 → negligible, 0.147–0.33 → small, 0.33–0.474 → medium,
        > 0.474 → large.
        """
        a = abs(self.value)
        if self.name in ("cliffs_delta",):
            if a < 0.147:
                return "negligible"
            if a < 0.33:
                return "small"
            if a < 0.474:
                return "medium"
            return "large"
        if a < 0.2:
            return "negligible"
        if a < 0.5:
            return "small"
        if a < 0.8:
            return "medium"
        return "large"

    def to_dict(self) -> dict[str, object]:
        """Plain dict form."""
        return {
            "name": self.name,
            "value": self.value,
            "ci_low": self.ci_low,
            "ci_high": self.ci_high,
            "interpretation": self.interpretation,
            "magnitude": self.magnitude,
        }


# ──────────────────────────── Cohen's d ──────────────────────────────────


def cohens_d(sample1: Sequence[float], sample2: Sequence[float]) -> EffectSizeResult:
    """Cohen's d for two independent samples, using pooled SD.

    ``d = (mean1 - mean2) / s_pooled`` where
    ``s_pooled = sqrt(((n1-1)*var1 + (n2-1)*var2) / (n1 + n2 - 2))``.
    """
    n1, n2 = len(sample1), len(sample2)
    if n1 < 2 or n2 < 2:
        return EffectSizeResult(name="cohens_d", value=0.0, interpretation="insufficient data")
    m1 = sum(sample1) / n1
    m2 = sum(sample2) / n2
    v1 = sum((x - m1) ** 2 for x in sample1) / (n1 - 1)
    v2 = sum((x - m2) ** 2 for x in sample2) / (n2 - 1)
    sp = math.sqrt(((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2))
    if sp == 0:
        return EffectSizeResult(
            name="cohens_d",
            value=float("inf") if (m1 - m2) != 0 else 0.0,
            interpretation="pooled SD is zero",
        )
    d = (m1 - m2) / sp
    return EffectSizeResult(
        name="cohens_d", value=d, interpretation=f"mean1-mean2={m1-m2:.4f}, s_pooled={sp:.4f}"
    )


def cohens_d_paired(deltas: Sequence[float]) -> EffectSizeResult:
    """Cohen's d for paired samples.

    ``d = mean(deltas) / sd(deltas)``.
    """
    n = len(deltas)
    if n < 2:
        return EffectSizeResult(name="cohens_d_paired", value=0.0, interpretation="n < 2")
    mean = sum(deltas) / n
    var = sum((d - mean) ** 2 for d in deltas) / (n - 1)
    sd = math.sqrt(var)
    if sd == 0:
        return EffectSizeResult(
            name="cohens_d_paired",
            value=float("inf") if mean != 0 else 0.0,
            interpretation="sd is zero",
        )
    return EffectSizeResult(
        name="cohens_d_paired", value=mean / sd, interpretation=f"mean={mean:.4f}, sd={sd:.4f}"
    )


# ──────────────────────────── Hedges' g ──────────────────────────────────


def hedges_g(sample1: Sequence[float], sample2: Sequence[float]) -> EffectSizeResult:
    """Hedges' g — bias-corrected Cohen's d for small samples.

    Applies the correction factor ``J = 1 - 3/(4*df - 1)`` where
    ``df = n1 + n2 - 2``.
    """
    d = cohens_d(sample1, sample2)
    n1, n2 = len(sample1), len(sample2)
    df = n1 + n2 - 2
    if df < 1:
        return EffectSizeResult(name="hedges_g", value=0.0, interpretation="df < 1")
    j = 1 - 3 / (4 * df - 1)
    return EffectSizeResult(
        name="hedges_g",
        value=d.value * j,
        interpretation=f"d={d.value:.4f}, J={j:.4f}",
    )


def hedges_g_paired(deltas: Sequence[float]) -> EffectSizeResult:
    """Hedges' g for paired samples (bias-corrected)."""
    d = cohens_d_paired(deltas)
    n = len(deltas)
    df = n - 1
    if df < 1:
        return EffectSizeResult(name="hedges_g_paired", value=0.0, interpretation="df < 1")
    j = 1 - 3 / (4 * (n + df) - 1)  # paired-sample approximation
    return EffectSizeResult(
        name="hedges_g_paired",
        value=d.value * j,
        interpretation=f"d_paired={d.value:.4f}, J={j:.4f}",
    )


# ──────────────────────────── Cohen's h ──────────────────────────────────


def cohens_h(p1: float, p2: float) -> EffectSizeResult:
    """Cohen's h for two proportions.

    ``h = 2 * (arcsin(sqrt(p1)) - arcsin(sqrt(p2)))``.
    """
    if not 0 <= p1 <= 1 or not 0 <= p2 <= 1:
        raise ValueError("proportions must be in [0, 1]")
    h = 2 * (math.asin(math.sqrt(p1)) - math.asin(math.sqrt(p2)))
    return EffectSizeResult(name="cohens_h", value=h)


# ──────────────────────────── Odds ratio ─────────────────────────────────


@dataclass(frozen=True)
class OddsRatioResult:
    """Odds ratio with Haldane-Anscombe correction for zero cells."""

    value: float
    ci_low: float
    ci_high: float
    table: tuple[int, int, int, int]  # (a, b, c, d)
    method: str = "wald_with_haldane"

    def to_dict(self) -> dict[str, object]:
        """Plain dict form."""
        return {
            "value": self.value,
            "ci_low": self.ci_low,
            "ci_high": self.ci_high,
            "table": list(self.table),
            "method": self.method,
        }


def odds_ratio(a: int, b: int, c: int, d: int, confidence_level: float = 0.95) -> OddsRatioResult:
    """Odds ratio for a 2x2 table [[a, b], [c, d]].

    Uses Haldane-Anscombe 0.5 correction when any cell is zero. CI is the
    Wald CI on the log-odds ratio.
    """
    if a < 0 or b < 0 or c < 0 or d < 0:
        raise ValueError("cell counts must be non-negative")
    if any(x == 0 for x in (a, b, c, d)):
        a2, b2, c2, d2 = a + 0.5, b + 0.5, c + 0.5, d + 0.5
        method = "haldane_anscombe"
    else:
        a2, b2, c2, d2 = float(a), float(b), float(c), float(d)
        method = "wald"
    or_val = (a2 * d2) / (b2 * c2)
    log_or = math.log(or_val)
    se = math.sqrt(1 / a2 + 1 / b2 + 1 / c2 + 1 / d2)
    from .bootstrap import _normal_ppf

    z = _normal_ppf(1 - (1 - confidence_level) / 2)
    ci_low = math.exp(log_or - z * se)
    ci_high = math.exp(log_or + z * se)
    return OddsRatioResult(
        value=or_val,
        ci_low=ci_low,
        ci_high=ci_high,
        table=(a, b, c, d),
        method=method,
    )


def relative_risk(a: int, b: int, c: int, d: int, confidence_level: float = 0.95) -> OddsRatioResult:
    """Relative risk for a 2x2 table [[a, b], [c, d]].

    ``RR = (a / (a + b)) / (c / (c + d))``. CI via the delta method on the
    log scale.
    """
    if a + b == 0 or c + d == 0:
        raise ValueError("row totals must be positive")
    p1 = a / (a + b)
    p2 = c / (c + d)
    if p2 == 0 or p1 == 0:
        # Apply Haldane-Anscombe.
        p1 = (a + 0.5) / (a + b + 1)
        p2 = (c + 0.5) / (c + d + 1)
    rr = p1 / p2
    log_rr = math.log(rr)
    se = math.sqrt(1 / max(a, 0.5) - 1 / (a + b) + 1 / max(c, 0.5) - 1 / (c + d))
    from .bootstrap import _normal_ppf

    z = _normal_ppf(1 - (1 - confidence_level) / 2)
    ci_low = math.exp(log_rr - z * se)
    ci_high = math.exp(log_rr + z * se)
    return OddsRatioResult(
        value=rr,
        ci_low=ci_low,
        ci_high=ci_high,
        table=(a, b, c, d),
        method="delta_method",
    )


# ──────────────────────────── Cliff's delta ──────────────────────────────


@dataclass(frozen=True)
class CliffsDeltaResult:
    """Cliff's delta — non-parametric effect size for two independent samples."""

    value: float
    n1: int
    n2: int
    interpretation: str = ""

    @property
    def magnitude(self) -> str:
        """Cohen-style magnitude classification."""
        a = abs(self.value)
        if a < 0.147:
            return "negligible"
        if a < 0.33:
            return "small"
        if a < 0.474:
            return "medium"
        return "large"


def cliffs_delta(sample1: Sequence[float], sample2: Sequence[float]) -> CliffsDeltaResult:
    """Cliff's delta = (#(x1 > x2) - #(x1 < x2)) / (n1 * n2).

    Ranges from -1 (all sample1 < sample2) to +1 (all sample1 > sample2).
    """
    n1, n2 = len(sample1), len(sample2)
    if n1 == 0 or n2 == 0:
        return CliffsDeltaResult(value=0.0, n1=n1, n2=n2, interpretation="empty sample")
    more = sum(1 for x1 in sample1 for x2 in sample2 if x1 > x2)
    less = sum(1 for x1 in sample1 for x2 in sample2 if x1 < x2)
    delta = (more - less) / (n1 * n2)
    return CliffsDeltaResult(value=delta, n1=n1, n2=n2)

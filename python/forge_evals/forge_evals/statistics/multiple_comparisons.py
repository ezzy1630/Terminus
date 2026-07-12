"""SPEC §41.6 multiple-comparison corrections.

When an experiment varies many knobs simultaneously (e.g. SPEC §41.8 —
context ablations list 12 dimensions), the family-wise error rate
inflates. This module provides standard corrections:

- Bonferroni (FWER control, conservative);
- Holm-Bonferroni (FWER control, uniformly more powerful than Bonferroni);
- Benjamini-Hochberg (FDR control);
- Benjamini-Yekutieli (FDR control under arbitrary dependence).

All functions take a list of p-values and return a list of adjusted
p-values in the same order. ``reject_decisions`` returns booleans for
each hypothesis at the chosen alpha.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

__all__ = [
    "AdjustedPValues",
    "benjamini_hochberg",
    "benjamini_yekutieli",
    "bonferroni",
    "holm_bonferroni",
    "reject_decisions",
]


@dataclass(frozen=True)
class AdjustedPValues:
    """Adjusted p-values for a family of tests."""

    method: str
    raw: list[float]
    adjusted: list[float]
    alpha: float
    rejected: list[bool]

    @property
    def n_rejected(self) -> int:
        """Number of hypotheses rejected at ``alpha``."""
        return sum(1 for r in self.rejected if r)


def bonferroni(p_values: Sequence[float], alpha: float = 0.05) -> AdjustedPValues:
    """Bonferroni correction: multiply each p-value by the family size.

    The adjusted p-value is ``min(1.0, p * n)``. By convention, when a
    single p-value is supplied (``n == 1``) the family-size multiplier
    is 1, so the adjusted p-value is the original p-value (not capped at
    1 unless the original exceeds 1). The cap at 1.0 only kicks in when
    ``p * n > 1``.
    """
    n = len(p_values)
    adjusted = [min(1.0, p * n) for p in p_values]
    rejected = [a < alpha for a in adjusted]
    return AdjustedPValues(
        method="bonferroni",
        raw=list(p_values),
        adjusted=adjusted,
        alpha=alpha,
        rejected=rejected,
    )


def holm_bonferroni(p_values: Sequence[float], alpha: float = 0.05) -> AdjustedPValues:
    """Holm-Bonferroni step-down procedure.

    Sorts p-values ascending; for the i-th smallest, compares against
    ``alpha / (n - i)``. Once one fails to reject, all remaining fail.
    """
    n = len(p_values)
    indexed = sorted(enumerate(p_values), key=lambda kv: kv[1])
    adjusted = [0.0] * n
    rejected = [False] * n
    reject_so_far = True
    for rank, (orig_idx, p) in enumerate(indexed):
        # Adjusted p = max of (n - rank) * p and previous adjusted.
        candidate = (n - rank) * p
        if rank > 0:
            prev_adj = adjusted[indexed[rank - 1][0]]
            candidate = max(candidate, prev_adj)
        candidate = min(1.0, candidate)
        adjusted[orig_idx] = candidate
        if reject_so_far and candidate < alpha:
            rejected[orig_idx] = True
        else:
            reject_so_far = False
    return AdjustedPValues(
        method="holm_bonferroni",
        raw=list(p_values),
        adjusted=adjusted,
        alpha=alpha,
        rejected=rejected,
    )


def benjamini_hochberg(p_values: Sequence[float], alpha: float = 0.05) -> AdjustedPValues:
    """Benjamini-Hochberg FDR control (assumes independence or PRDS)."""
    n = len(p_values)
    if n == 0:
        return AdjustedPValues(
            method="benjamini_hochberg", raw=[], adjusted=[], alpha=alpha, rejected=[]
        )
    indexed = sorted(enumerate(p_values), key=lambda kv: kv[1])
    adjusted = [0.0] * n
    # Walk from largest to smallest; adjusted = min(prev_adj, n/i * p_i).
    running_min = float("inf")
    for rank in range(n - 1, -1, -1):
        orig_idx, p = indexed[rank]
        i = rank + 1  # 1-indexed rank
        candidate = (n / i) * p
        running_min = min(running_min, candidate)
        adjusted[orig_idx] = min(1.0, running_min)
    # Find the largest rank where p_i <= (i/n) * alpha; reject all <= that rank.
    # If no rank satisfies the threshold, no hypotheses are rejected.
    rejected = [False] * n
    threshold_rank = -1  # sentinel: no rejections yet
    for rank, (orig_idx, p) in enumerate(indexed):
        i = rank + 1
        if p <= (i / n) * alpha:
            threshold_rank = rank
        else:
            break
    for rank in range(threshold_rank + 1):
        orig_idx, _ = indexed[rank]
        rejected[orig_idx] = True
    return AdjustedPValues(
        method="benjamini_hochberg",
        raw=list(p_values),
        adjusted=adjusted,
        alpha=alpha,
        rejected=rejected,
    )


def benjamini_yekutieli(p_values: Sequence[float], alpha: float = 0.05) -> AdjustedPValues:
    """Benjamini-Yekutieli FDR control (arbitrary dependence)."""
    n = len(p_values)
    if n == 0:
        return AdjustedPValues(
            method="benjamini_yekutieli", raw=[], adjusted=[], alpha=alpha, rejected=[]
        )
    # c(n) = sum(1/i for i in 1..n)
    c_n = sum(1.0 / i for i in range(1, n + 1))
    indexed = sorted(enumerate(p_values), key=lambda kv: kv[1])
    adjusted = [0.0] * n
    running_min = float("inf")
    for rank in range(n - 1, -1, -1):
        orig_idx, p = indexed[rank]
        i = rank + 1
        candidate = (n * c_n / i) * p
        running_min = min(running_min, candidate)
        adjusted[orig_idx] = min(1.0, running_min)
    rejected = [a < alpha for a in adjusted]
    return AdjustedPValues(
        method="benjamini_yekutieli",
        raw=list(p_values),
        adjusted=adjusted,
        alpha=alpha,
        rejected=rejected,
    )


def reject_decisions(adjusted: AdjustedPValues, alpha: float | None = None) -> list[bool]:
    """Return rejection decisions at ``alpha`` (defaults to ``adjusted.alpha``)."""
    a = alpha if alpha is not None else adjusted.alpha
    return [adj < a for adj in adjusted.adjusted]

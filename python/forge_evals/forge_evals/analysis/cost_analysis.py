"""SPEC §41.5 cost reconciliation.

For every run, the harness reports a cost (``provider_reported_usd``) and
the eval lab independently computes a cost from token usage and pricing.
Disagreements beyond a small tolerance are *accounting anomalies* and must
be flagged for review.

This module provides:

- :func:`reconcile_costs` — per-run reconciliation.
- :func:`find_anomalies` — flag runs with anomalous deltas.
- :func:`summarize_cost_deltas` — cohort-level cost delta summaries.

SPEC §50.7: "Cost accounting reconciles" — this is the gate.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field

import polars as pl

from ..run_record import CostBreakdown, RunRecord
from .load_runs import RunCatalog

__all__ = [
    "CostAnomaly",
    "CostReconciliation",
    "find_anomalies",
    "reconcile_costs",
    "summarize_cost_deltas",
]


@dataclass(frozen=True)
class CostReconciliation:
    """Per-run cost reconciliation result."""

    run_id: str
    harness: str
    suite: str
    task: str
    provider_reported_usd: float
    computed_usd: float
    delta_usd: float
    delta_pct: float
    flagged: bool
    reason: str = ""

    def to_dict(self) -> dict[str, object]:
        """Plain dict form."""
        return {
            "run_id": self.run_id,
            "harness": self.harness,
            "suite": self.suite,
            "task": self.task,
            "provider_reported_usd": self.provider_reported_usd,
            "computed_usd": self.computed_usd,
            "delta_usd": self.delta_usd,
            "delta_pct": self.delta_pct,
            "flagged": self.flagged,
            "reason": self.reason,
        }


@dataclass(frozen=True)
class CostAnomaly:
    """A flagged cost reconciliation anomaly."""

    run_id: str
    harness: str
    suite: str
    task: str
    delta_usd: float
    delta_pct: float
    severity: str  # "low" | "medium" | "high"
    reason: str
    evidence: list[str] = field(default_factory=list)


def reconcile_costs(
    records: Iterable[RunRecord] | RunCatalog,
    absolute_tolerance_usd: float = 0.001,
    relative_tolerance_pct: float = 1.0,
) -> list[CostReconciliation]:
    """Reconcile provider-reported vs computed cost for each record."""
    recs = _coerce(records)
    out: list[CostReconciliation] = []
    for r in recs:
        if r.cost is None:
            out.append(
                CostReconciliation(
                    run_id=r.run_id,
                    harness=r.harness,
                    suite=r.suite,
                    task=r.task,
                    provider_reported_usd=0.0,
                    computed_usd=0.0,
                    delta_usd=0.0,
                    delta_pct=0.0,
                    flagged=False,
                    reason="no cost record",
                )
            )
            continue
        out.append(_reconcile_one(r, absolute_tolerance_usd, relative_tolerance_pct))
    return out


def _reconcile_one(
    r: RunRecord,
    abs_tol: float,
    rel_tol: float,
) -> CostReconciliation:
    """Reconcile a single record."""
    cost: CostBreakdown = r.cost  # type: ignore[assignment]
    delta = cost.provider_reported_usd - cost.computed_usd
    delta_pct = (delta / cost.computed_usd * 100) if cost.computed_usd > 0 else 0.0
    flagged = abs(delta) > abs_tol and abs(delta_pct) > rel_tol
    if flagged:
        # Categorize the reason for the anomaly.
        if abs(delta_pct) > 50:
            reason = f"large discrepancy ({delta_pct:+.1f}%)"
        elif cost.input_tokens == 0 and cost.output_tokens == 0:
            reason = "zero reported token usage"
        elif cost.cached_tokens > 0 and cost.cached_tokens > cost.input_tokens:
            reason = "cached tokens exceed input tokens"
        else:
            reason = f"discrepancy {delta_pct:+.1f}% (delta={delta:+.6f} USD)"
    else:
        reason = "ok"
    return CostReconciliation(
        run_id=r.run_id,
        harness=r.harness,
        suite=r.suite,
        task=r.task,
        provider_reported_usd=cost.provider_reported_usd,
        computed_usd=cost.computed_usd,
        delta_usd=delta,
        delta_pct=delta_pct,
        flagged=flagged,
        reason=reason,
    )


def find_anomalies(
    records: Iterable[RunRecord] | RunCatalog,
    absolute_tolerance_usd: float = 0.001,
    relative_tolerance_pct: float = 1.0,
) -> list[CostAnomaly]:
    """Return all cost reconciliation anomalies, with severity classification."""
    reconciliations = reconcile_costs(
        records,
        absolute_tolerance_usd=absolute_tolerance_usd,
        relative_tolerance_pct=relative_tolerance_pct,
    )
    out: list[CostAnomaly] = []
    for rec in reconciliations:
        if not rec.flagged:
            continue
        abs_pct = abs(rec.delta_pct)
        if abs_pct > 50:
            severity = "high"
        elif abs_pct > 10:
            severity = "medium"
        else:
            severity = "low"
        out.append(
            CostAnomaly(
                run_id=rec.run_id,
                harness=rec.harness,
                suite=rec.suite,
                task=rec.task,
                delta_usd=rec.delta_usd,
                delta_pct=rec.delta_pct,
                severity=severity,
                reason=rec.reason,
                evidence=[
                    f"provider_reported={rec.provider_reported_usd:.6f}",
                    f"computed={rec.computed_usd:.6f}",
                ],
            )
        )
    return out


def summarize_cost_deltas(
    records: Iterable[RunRecord] | RunCatalog,
) -> pl.DataFrame:
    """One row per (harness, cohort) with cost delta summary stats."""
    recs = _coerce(records)
    rows: list[dict[str, object]] = []
    by_hc: dict[tuple[str, str], list[RunRecord]] = {}
    for r in recs:
        by_hc.setdefault((r.harness, r.suite), []).append(r)
    for (h, c), group in by_hc.items():
        deltas: list[float] = []
        delta_pcts: list[float] = []
        flagged_count = 0
        for r in group:
            if r.cost is None:
                continue
            delta = r.cost.provider_reported_usd - r.cost.computed_usd
            deltas.append(delta)
            if r.cost.computed_usd > 0:
                delta_pcts.append(delta / r.cost.computed_usd * 100)
            if r.cost.reconciliation_flagged:
                flagged_count += 1
        n = len(deltas)
        rows.append(
            {
                "harness": h,
                "cohort": c,
                "n": n,
                "mean_delta_usd": sum(deltas) / n if n > 0 else 0.0,
                "mean_delta_pct": sum(delta_pcts) / len(delta_pcts) if delta_pcts else 0.0,
                "max_abs_delta_pct": max((abs(p) for p in delta_pcts), default=0.0),
                "flagged_count": flagged_count,
                "flagged_rate": flagged_count / n if n > 0 else 0.0,
            }
        )
    return pl.DataFrame(rows) if rows else pl.DataFrame()


def _coerce(records: Iterable[RunRecord] | RunCatalog) -> list[RunRecord]:
    """Accept either a catalog or a raw iterable of records."""
    if isinstance(records, RunCatalog):
        return list(records.records)
    return list(records)

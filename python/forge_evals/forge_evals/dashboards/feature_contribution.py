"""SPEC §41.7 / §41.8 / §41.9 / §41.10 feature-contribution dashboard.

Ablation reports showing each feature's contribution to the primary metric.
Given a baseline run set and one or more ablation run sets (each with a
single component disabled), this dashboard shows:

- per-component delta vs baseline;
- bootstrap CI on the delta;
- effect size (Cohen's d);
- whether the component is *load-bearing* (delta significant in either
  direction).

SPEC §41.8: "per-layer counterfactual contribution" — this is the
context-ablation analogue. The same machinery applies to ACI (§41.9) and
orchestration (§41.10) ablations.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC
from pathlib import Path

from ..analysis.load_runs import RunCatalog
from ..analysis.regression_detector import match_pairs
from ..run_record import RunRecord
from ..statistics.bootstrap import bootstrap_ci
from ..statistics.effect_size import cohens_d_paired

__all__ = [
    "AblationContribution",
    "AblationReport",
    "ablation_report_html",
    "compute_ablation_contributions",
    "write_ablation_report",
]


@dataclass(frozen=True)
class AblationContribution:
    """One component's contribution to the primary metric.

    ``delta`` is the ablation's mean score minus the baseline's mean score
    (negative = component is *helpful*; removing it hurts the score).
    """

    component: str
    baseline_runs: int
    ablation_runs: int
    n_pairs: int
    delta_mean: float
    delta_ci_low: float
    delta_ci_high: float
    cohens_d: float
    is_load_bearing: bool
    interpretation: str

    def to_dict(self) -> dict[str, object]:
        """Plain dict form."""
        return {
            "component": self.component,
            "baseline_runs": self.baseline_runs,
            "ablation_runs": self.ablation_runs,
            "n_pairs": self.n_pairs,
            "delta_mean": self.delta_mean,
            "delta_ci_low": self.delta_ci_low,
            "delta_ci_high": self.delta_ci_high,
            "cohens_d": self.cohens_d,
            "is_load_bearing": self.is_load_bearing,
            "interpretation": self.interpretation,
        }


@dataclass
class AblationReport:
    """The full ablation report."""

    baseline_label: str
    contributions: list[AblationContribution] = field(default_factory=list)

    def to_dict(self) -> dict[str, object]:
        """Plain dict form."""
        return {
            "baseline_label": self.baseline_label,
            "contributions": [c.to_dict() for c in self.contributions],
        }


def compute_ablation_contributions(
    baseline: Iterable[RunRecord] | RunCatalog,
    ablations: dict[str, Iterable[RunRecord] | RunCatalog],
    *,
    baseline_label: str = "baseline",
    n_bootstrap: int = 2000,
    rng_seed: int = 0,
) -> AblationReport:
    """Compute per-component ablation contributions.

    ``ablations`` maps a component name (e.g. ``"memory"``, ``"evidence_coverage"``)
    to the run set with that component disabled. For each component:

    1. Match (task, seed) pairs between baseline and ablation.
    2. Compute per-pair delta on primary_score (ablation - baseline).
    3. Bootstrap CI on mean delta.
    4. Cohen's d on the paired deltas.
    5. ``is_load_bearing`` iff CI excludes 0.
    """
    report = AblationReport(baseline_label=baseline_label)
    for component, abl_records in ablations.items():
        pairs = match_pairs(baseline, abl_records)
        n_pairs = len(pairs)
        if n_pairs == 0:
            report.contributions.append(
                AblationContribution(
                    component=component,
                    baseline_runs=_count(baseline),
                    ablation_runs=_count(abl_records),
                    n_pairs=0,
                    delta_mean=0.0,
                    delta_ci_low=0.0,
                    delta_ci_high=0.0,
                    cohens_d=0.0,
                    is_load_bearing=False,
                    interpretation="no matched pairs",
                )
            )
            continue
        deltas = [c.primary_score - b.primary_score for b, c in pairs]
        mean_delta = sum(deltas) / n_pairs
        ci_lo, ci_hi = bootstrap_ci(
            deltas,
            lambda s: sum(s) / len(s) if s else 0.0,
            n_resamples=n_bootstrap,
            rng_seed=rng_seed,
        )
        d = cohens_d_paired(deltas).value
        is_lb = ci_lo > 0 or ci_hi < 0
        if mean_delta < -0.05 and ci_hi < 0:
            interpretation = "load-bearing: removing hurts"
        elif mean_delta > 0.05 and ci_lo > 0:
            interpretation = "harmful: removing helps"
        elif is_lb:
            interpretation = "small but significant effect"
        else:
            interpretation = "not load-bearing (CI includes 0)"
        report.contributions.append(
            AblationContribution(
                component=component,
                baseline_runs=_count(baseline),
                ablation_runs=_count(abl_records),
                n_pairs=n_pairs,
                delta_mean=mean_delta,
                delta_ci_low=ci_lo,
                delta_ci_high=ci_hi,
                cohens_d=d,
                is_load_bearing=is_lb,
                interpretation=interpretation,
            )
        )
    return report


def ablation_report_html(report: AblationReport, *, title: str | None = None) -> str:
    """Render an :class:`AblationReport` as a self-contained HTML document."""
    from datetime import datetime

    now = datetime.now(UTC).isoformat(timespec="seconds")
    title = title or f"Ablation Report — baseline: {report.baseline_label}"
    rows = "\n".join(_ablation_row(c) for c in report.contributions)
    n_components = len(report.contributions)
    n_load_bearing = sum(1 for c in report.contributions if c.is_load_bearing)
    return _TEMPLATE.format(
        title=title,
        generated_at=now,
        n_components=n_components,
        n_load_bearing=n_load_bearing,
        rows=rows,
    )


def write_ablation_report(
    report: AblationReport,
    output: Path | str,
    *,
    title: str | None = None,
) -> Path:
    """Write the ablation report HTML to ``output``."""
    p = Path(output)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(ablation_report_html(report, title=title), encoding="utf-8")
    return p


# ──────────────────────────── helpers ─────────────────────────────────────


def _count(records: Iterable[RunRecord] | RunCatalog) -> int:
    """Count records in either a catalog or iterable."""
    if isinstance(records, RunCatalog):
        return len(records.records)
    return sum(1 for _ in records)


def _delta_bar(value: float, lo: float, hi: float) -> str:
    """Render a horizontal bar centered at 0."""
    vmin = min(-0.2, lo, value)
    vmax = max(0.2, hi, value)
    span = vmax - vmin
    if span <= 0:
        return ""

    def pct(x: float) -> float:
        return max(0, min(100, (x - vmin) / span * 100))

    val_pct = pct(value)
    lo_pct = pct(lo)
    hi_pct = pct(hi)
    zero_pct = pct(0.0)
    return (
        f'<div class="bar-container">'
        f'<div class="bar-zero" style="left:{zero_pct:.1f}%"></div>'
        f'<div class="bar-whisker" style="left:{lo_pct:.1f}%;width:{hi_pct - lo_pct:.1f}%"></div>'
        f'<div class="bar-value" style="left:{val_pct:.1f}%"></div>'
        f"</div>"
    )


def _esc(s: str) -> str:
    """HTML-escape a string."""
    return (
        s.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
    )


_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>{title}</title>
  <style>
    body {{ font-family: -apple-system, system-ui, sans-serif; margin: 24px; color: #1a1a1a; }}
    h1 {{ font-size: 20px; margin-bottom: 4px; }}
    .meta {{ color: #6a6a6a; font-size: 13px; margin-bottom: 20px; }}
    table {{ border-collapse: collapse; width: 100%; font-size: 13px; }}
    th, td {{ text-align: left; padding: 6px 10px; border-bottom: 1px solid #e0e0e0; }}
    th {{ background: #f6f6f6; font-weight: 600; }}
    .bar-container {{ position: relative; width: 160px; height: 14px; background: #f0f0f0; border-radius: 3px; }}
    .bar-whisker {{ position: absolute; top: 4px; height: 6px; background: #90a4ae; border-radius: 2px; }}
    .bar-value {{ position: absolute; top: 2px; width: 4px; height: 10px; background: #1976d2; border-radius: 2px; }}
    .bar-zero {{ position: absolute; top: 0; width: 1px; height: 14px; background: #c62828; }}
    .num {{ font-variant-numeric: tabular-nums; }}
    .yes {{ color: #c62828; font-weight: 600; }}
    .no {{ color: #6a6a6a; }}
    .footer {{ margin-top: 24px; color: #6a6a6a; font-size: 12px; }}
  </style>
</head>
<body>
  <h1>{title}</h1>
  <div class="meta">Generated {generated_at} · {n_components} components · {n_load_bearing} load-bearing</div>
  <table>
    <thead>
      <tr>
        <th>Component</th>
        <th>Baseline N</th>
        <th>Ablation N</th>
        <th>Matched pairs</th>
        <th>Δ mean</th>
        <th>Δ CI (95%)</th>
        <th>Δ bar</th>
        <th>Cohen's d</th>
        <th>Load-bearing?</th>
        <th>Interpretation</th>
      </tr>
    </thead>
    <tbody>
{rows}
    </tbody>
  </table>
  <div class="footer">SPEC §41.8 / §41.9 / §41.10 — per-component counterfactual contribution. Δ is ablation minus baseline; negative Δ means removing the component hurts.</div>
</body>
</html>
"""

_ROW = """      <tr>
        <td>{component}</td>
        <td class="num">{baseline_runs}</td>
        <td class="num">{ablation_runs}</td>
        <td class="num">{n_pairs}</td>
        <td class="num">{delta:+.4f}</td>
        <td class="num">{ci}</td>
        <td>{bar}</td>
        <td class="num">{d:+.3f}</td>
        <td class="{cls}">{load_bearing}</td>
        <td>{interp}</td>
      </tr>"""


def _ablation_row(c: AblationContribution) -> str:
    """Render a single ablation contribution row (with cls substitution)."""
    bar = _delta_bar(c.delta_mean, c.delta_ci_low, c.delta_ci_high)
    cls = "yes" if c.is_load_bearing else "no"
    return _ROW.format(
        component=_esc(c.component),
        baseline_runs=c.baseline_runs,
        ablation_runs=c.ablation_runs,
        n_pairs=c.n_pairs,
        delta=c.delta_mean,
        ci=f"[{c.delta_ci_low:.4f}, {c.delta_ci_high:.4f}]",
        bar=bar,
        d=c.cohens_d,
        load_bearing="yes" if c.is_load_bearing else "no",
        cls=cls,
        interp=_esc(c.interpretation),
    )

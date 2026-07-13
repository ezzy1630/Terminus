"""SPEC §41.6 cohort dashboard.

Generates a self-contained HTML dashboard showing per-cohort success rates,
cost, latency, and confidence intervals. Uses Polars for aggregation and
Jinja2-style string templates (no external Jinja2 dependency) — the HTML is
fully self-contained and can be opened in any browser.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path

from ..analysis.aggregate import CohortSummary, aggregate_by_harness_cohort
from ..analysis.load_runs import RunCatalog
from ..run_record import RunRecord

__all__ = ["cohort_dashboard_html", "write_cohort_dashboard"]


def cohort_dashboard_html(
    records: Iterable[RunRecord] | RunCatalog,
    *,
    title: str = "Terminus Eval Lab — Cohort Dashboard",
    baseline_harness: str | None = None,
) -> str:
    """Build the cohort dashboard HTML."""
    summaries = aggregate_by_harness_cohort(records)
    return _render(summaries, title=title, baseline_harness=baseline_harness)


def write_cohort_dashboard(
    records: Iterable[RunRecord] | RunCatalog,
    output: Path | str,
    *,
    title: str = "Terminus Eval Lab — Cohort Dashboard",
    baseline_harness: str | None = None,
) -> Path:
    """Write the cohort dashboard to ``output``."""
    html = cohort_dashboard_html(records, title=title, baseline_harness=baseline_harness)
    p = Path(output)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(html, encoding="utf-8")
    return p


# ──────────────────────────── rendering ───────────────────────────────────


def _render(
    summaries: list[CohortSummary],
    *,
    title: str,
    baseline_harness: str | None,
) -> str:
    """Render the dashboard HTML."""
    now = datetime.now(UTC).isoformat(timespec="seconds")
    rows_html = "\n".join(_render_row(s, baseline_harness) for s in summaries)
    n_runs = sum(s.n for s in summaries)
    n_cohorts = len({s.cohort for s in summaries})
    n_harnesses = len({s.harness for s in summaries})
    return _TEMPLATE.format(
        title=title,
        generated_at=now,
        n_runs=n_runs,
        n_cohorts=n_cohorts,
        n_harnesses=n_harnesses,
        rows=rows_html,
    )


def _render_row(s: CohortSummary, baseline_harness: str | None) -> str:
    """Render a single summary row as an HTML <tr>."""
    sr_bar = _bar(s.success_rate, s.success_rate_ci_low, s.success_rate_ci_high, 0.0, 1.0)
    ms_bar = _bar(s.mean_score, s.mean_score_ci_low, s.mean_score_ci_high, 0.0, 1.0)
    is_baseline = baseline_harness is not None and s.harness == baseline_harness
    row_class = "baseline-row" if is_baseline else ""
    return _ROW_TEMPLATE.format(
        cohort=_esc(s.cohort),
        harness=_esc(s.harness),
        n=s.n,
        sr=s.success_rate,
        sr_ci=f"[{s.success_rate_ci_low:.3f}, {s.success_rate_ci_high:.3f}]",
        sr_bar=sr_bar,
        ms=s.mean_score,
        ms_ci=f"[{s.mean_score_ci_low:.3f}, {s.mean_score_ci_high:.3f}]",
        ms_bar=ms_bar,
        dur=s.median_duration_seconds,
        p50=s.p50_cost_usd,
        p95=s.p95_cost_usd,
        in_tok=s.total_input_tokens,
        out_tok=s.total_output_tokens,
        cached_tok=s.total_cached_tokens,
        row_class=row_class,
    )


def _bar(value: float, lo: float, hi: float, vmin: float, vmax: float) -> str:
    """Render a horizontal bar showing value with CI whiskers."""
    span = vmax - vmin
    if span <= 0:
        return ""

    def pct(x: float) -> float:
        return max(0, min(100, (x - vmin) / span * 100))

    val_pct = pct(value)
    lo_pct = pct(lo)
    hi_pct = pct(hi)
    return (
        f'<div class="bar-container">'
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
    .baseline-row {{ background: #fff8e1; }}
    .bar-container {{ position: relative; width: 120px; height: 14px; background: #f0f0f0; border-radius: 3px; }}
    .bar-whisker {{ position: absolute; top: 4px; height: 6px; background: #90a4ae; border-radius: 2px; }}
    .bar-value {{ position: absolute; top: 2px; width: 4px; height: 10px; background: #1976d2; border-radius: 2px; }}
    .num {{ font-variant-numeric: tabular-nums; }}
    .footer {{ margin-top: 24px; color: #6a6a6a; font-size: 12px; }}
  </style>
</head>
<body>
  <h1>{title}</h1>
  <div class="meta">Generated {generated_at} · {n_runs} runs · {n_cohorts} cohorts · {n_harnesses} harnesses</div>
  <table>
    <thead>
      <tr>
        <th>Cohort</th>
        <th>Harness</th>
        <th>N</th>
        <th>Success rate</th>
        <th>SR CI</th>
        <th>SR bar</th>
        <th>Mean score</th>
        <th>MS CI</th>
        <th>MS bar</th>
        <th>P50 dur (s)</th>
        <th>P50 cost (USD)</th>
        <th>P95 cost (USD)</th>
        <th>In tok</th>
        <th>Out tok</th>
        <th>Cached tok</th>
      </tr>
    </thead>
    <tbody>
{rows}
    </tbody>
  </table>
  <div class="footer">SPEC §41.6 — bootstrap CIs are 95% percentile-method on the per-run mean.</div>
</body>
</html>
"""

_ROW_TEMPLATE = """      <tr class="{row_class}">
        <td>{cohort}</td>
        <td>{harness}</td>
        <td class="num">{n}</td>
        <td class="num">{sr:.3f}</td>
        <td class="num">{sr_ci}</td>
        <td>{sr_bar}</td>
        <td class="num">{ms:.3f}</td>
        <td class="num">{ms_ci}</td>
        <td>{ms_bar}</td>
        <td class="num">{dur:.1f}</td>
        <td class="num">{p50:.6f}</td>
        <td class="num">{p95:.6f}</td>
        <td class="num">{in_tok}</td>
        <td class="num">{out_tok}</td>
        <td class="num">{cached_tok}</td>
      </tr>"""

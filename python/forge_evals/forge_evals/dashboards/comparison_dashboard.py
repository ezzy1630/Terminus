"""SPEC §41.1 / §41.2 comparative HTML dashboard generator.

Generates a styled, self-contained HTML dashboard comparing Terminus minimal,
Terminus full, and external baselines across benchmark cohorts.
"""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path

from ..analysis.aggregate import aggregate_by_harness_cohort
from ..baselines import BASELINES
from ..run_record import RunRecord

__all__ = ["generate_comparison_dashboard_html", "write_comparison_dashboard"]


def generate_comparison_dashboard_html(
    records: Iterable[RunRecord], title: str = "Terminus Eval Laboratory — Comparison Dashboard"
) -> str:
    """Generate HTML content for the comparison dashboard."""
    recs = list(records)
    summaries = aggregate_by_harness_cohort(recs)

    # Capability matrix table rows
    cap_rows = []
    for b in BASELINES:
        c = b.capabilities
        cap_rows.append(
            f"<tr>"
            f"<td><strong>{b.name}</strong> (<code>{b.id}</code>)</td>"
            f"<td>{'✓' if c.supports_mcp else '✗'}</td>"
            f"<td>{'✓' if c.supports_subagents else '✗'}</td>"
            f"<td>{'✓' if c.supports_context_compilation else '✗'}</td>"
            f"<td>{'✓' if c.supports_verification_loop else '✗'}</td>"
            f"<td><code>{', '.join(c.supported_tools[:3])}</code></td>"
            f"<td>{c.max_turns_supported}</td>"
            f"</tr>"
        )
    cap_table = "\n".join(cap_rows)

    # Summary table rows
    sum_rows = []
    for s in summaries:
        sr_pct = s.success_rate * 100
        sum_rows.append(
            f"<tr>"
            f"<td><code>{s.cohort}</code></td>"
            f"<td><strong>{s.harness}</strong></td>"
            f"<td>{s.n}</td>"
            f"<td>{sr_pct:.1f}% ({s.success_rate_ci_low*100:.1f}% - {s.success_rate_ci_high*100:.1f}%)</td>"
            f"<td>{s.mean_score:.3f}</td>"
            f"<td>${s.p50_cost_usd:.4f}</td>"
            f"<td>{s.median_duration_seconds:.1f}s</td>"
            f"</tr>"
        )
    sum_table = "\n".join(sum_rows) if sum_rows else "<tr><td colspan='7'>No runs recorded</td></tr>"

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>{title}</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 20px; background: #0f172a; color: #f8fafc; }}
    h1, h2 {{ color: #38bdf8; }}
    .card {{ background: #1e293b; padding: 20px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.3); }}
    table {{ width: 100%; border-collapse: collapse; margin-top: 10px; }}
    th, td {{ padding: 10px 14px; text-align: left; border-bottom: 1px solid #334155; }}
    th {{ background: #0f172a; color: #94a3b8; font-weight: 600; }}
    tr:hover {{ background: #334155; }}
    code {{ background: #090d16; padding: 2px 6px; border-radius: 4px; color: #f43f5e; }}
  </style>
</head>
<body>
  <h1>{title}</h1>
  
  <div class="card">
    <h2>Baseline Capability Matrix</h2>
    <table>
      <thead>
        <tr>
          <th>Baseline Harness</th>
          <th>MCP</th>
          <th>Subagents</th>
          <th>Context Compiler</th>
          <th>Verification</th>
          <th>Tools</th>
          <th>Max Turns</th>
        </tr>
      </thead>
      <tbody>
        {cap_table}
      </tbody>
    </table>
  </div>

  <div class="card">
    <h2>Performance & Cost Summary</h2>
    <table>
      <thead>
        <tr>
          <th>Cohort</th>
          <th>Harness</th>
          <th>Runs (N)</th>
          <th>Success Rate (95% CI)</th>
          <th>Mean Score</th>
          <th>p50 Cost</th>
          <th>Median Time</th>
        </tr>
      </thead>
      <tbody>
        {sum_table}
      </tbody>
    </table>
  </div>
</body>
</html>
"""
    return html


def write_comparison_dashboard(
    records: Iterable[RunRecord],
    output_path: Path | str,
    title: str = "Terminus Eval Laboratory — Comparison Dashboard",
) -> Path:
    """Write the comparison dashboard HTML to file."""
    p = Path(output_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    html = generate_comparison_dashboard_html(records, title=title)
    p.write_text(html, encoding="utf-8")
    return p

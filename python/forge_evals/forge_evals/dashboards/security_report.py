"""SPEC §18.5 / §41.11 security report dashboard.

Renders the security grader results from one or more runs as a self-contained
HTML dashboard. Shows per-grader pass/fail counts, failure examples, and the
overall security verdict — **a single security guardrail failure blocks
promotion regardless of average task success** (SPEC §41.11, §41.12).
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC
from pathlib import Path

from ..run_record import RunRecord

__all__ = [
    "SecurityGraderSummary",
    "SecurityReport",
    "compute_security_report",
    "security_report_html",
    "write_security_report",
]


@dataclass(frozen=True)
class SecurityGraderSummary:
    """Per-grader pass/fail summary across all runs."""

    grader_id: str
    grader_version: str
    n_runs: int
    n_passed: int
    n_failed: int
    pass_rate: float
    failure_examples: list[str]

    def to_dict(self) -> dict[str, object]:
        """Plain dict form."""
        return {
            "grader_id": self.grader_id,
            "grader_version": self.grader_version,
            "n_runs": self.n_runs,
            "n_passed": self.n_passed,
            "n_failed": self.n_failed,
            "pass_rate": self.pass_rate,
            "failure_examples": list(self.failure_examples),
        }


@dataclass
class SecurityReport:
    """The full security report across all runs."""

    n_runs: int
    grader_summaries: list[SecurityGraderSummary] = field(default_factory=list)
    blocking_failures: list[str] = field(default_factory=list)
    overall_passed: bool = True

    def to_dict(self) -> dict[str, object]:
        """Plain dict form."""
        return {
            "n_runs": self.n_runs,
            "grader_summaries": [s.to_dict() for s in self.grader_summaries],
            "blocking_failures": list(self.blocking_failures),
            "overall_passed": self.overall_passed,
        }


def compute_security_report(records: Iterable[RunRecord]) -> SecurityReport:
    """Aggregate security grader results across runs.

    A grader is "a security grader" iff its ``grader_id`` starts with
    ``security.``. The overall verdict is ``False`` if any security grader
    failed in any run.
    """
    rec_list = list(records)
    n_runs = len(rec_list)
    by_grader: dict[str, list[tuple[str, str, bool, list[str]]]] = defaultdict(list)
    blocking: list[str] = []
    for r in rec_list:
        for g in r.grader_results:
            if not g.grader_id.startswith("security."):
                continue
            by_grader[g.grader_id].append((g.grader_version, r.run_id, g.passed, list(g.evidence)))
            if not g.passed:
                blocking.append(f"{g.grader_id} on run {r.run_id}")
    summaries: list[SecurityGraderSummary] = []
    for grader_id, entries in sorted(by_grader.items()):
        version = entries[0][0]
        n_passed = sum(1 for _, _, p, _ in entries if p)
        n_failed = len(entries) - n_passed
        examples = [f"run={rid}: {'; '.join(ev[:2])}" for _, rid, p, ev in entries if not p][:3]
        summaries.append(
            SecurityGraderSummary(
                grader_id=grader_id,
                grader_version=version,
                n_runs=len(entries),
                n_passed=n_passed,
                n_failed=n_failed,
                pass_rate=n_passed / len(entries) if entries else 0.0,
                failure_examples=examples,
            )
        )
    return SecurityReport(
        n_runs=n_runs,
        grader_summaries=summaries,
        blocking_failures=blocking,
        overall_passed=len(blocking) == 0,
    )


def security_report_html(report: SecurityReport, *, title: str | None = None) -> str:
    """Render a :class:`SecurityReport` as a self-contained HTML document."""
    from datetime import datetime

    now = datetime.now(UTC).isoformat(timespec="seconds")
    title = title or "Terminus Eval Lab — Security Report"
    rows = "\n".join(_security_row(s) for s in report.grader_summaries)
    blocking_html = ""
    if report.blocking_failures:
        items = "\n".join(f"      <li>{_esc(b)}</li>" for b in report.blocking_failures[:20])
        blocking_html = (
            '<div class="blocking">\n'
            "  <h2>Blocking failures</h2>\n"
            "  <p>Security guardrail failure blocks promotion regardless of "
            "average task success (SPEC §41.11).</p>\n"
            f"  <ul>\n{items}\n  </ul>\n"
            "</div>"
        )
    verdict_class = "verdict-pass" if report.overall_passed else "verdict-fail"
    verdict_text = "PASS" if report.overall_passed else "FAIL"
    return _TEMPLATE.format(
        title=title,
        generated_at=now,
        n_runs=report.n_runs,
        verdict=verdict_text,
        verdict_class=verdict_class,
        rows=rows,
        blocking=blocking_html,
    )


def write_security_report(
    report: SecurityReport,
    output: Path | str,
    *,
    title: str | None = None,
) -> Path:
    """Write the security report HTML to ``output``."""
    p = Path(output)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(security_report_html(report, title=title), encoding="utf-8")
    return p


# ──────────────────────────── helpers ─────────────────────────────────────


def _security_row(s: SecurityGraderSummary) -> str:
    """Render a single security grader summary row."""
    cls = "pass" if s.n_failed == 0 else "fail"
    examples = "; ".join(s.failure_examples) if s.failure_examples else "(none)"
    return _ROW.format(
        grader_id=_esc(s.grader_id),
        version=_esc(s.grader_version),
        n_runs=s.n_runs,
        n_passed=s.n_passed,
        n_failed=s.n_failed,
        pass_rate=f"{s.pass_rate:.3f}",
        cls=cls,
        examples=_esc(examples),
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
    .verdict {{ display: inline-block; padding: 6px 12px; border-radius: 4px; font-weight: 700; font-size: 14px; }}
    .verdict-pass {{ background: #c8e6c9; color: #1b5e20; }}
    .verdict-fail {{ background: #ffcdd2; color: #b71c1c; }}
    .blocking {{ margin-top: 24px; padding: 16px; background: #fff4e5; border-left: 4px solid #ff6f00; }}
    .blocking h2 {{ font-size: 16px; margin: 0 0 8px 0; }}
    .blocking ul {{ margin: 8px 0 0 16px; padding: 0; }}
    table {{ border-collapse: collapse; width: 100%; font-size: 13px; margin-top: 20px; }}
    th, td {{ text-align: left; padding: 6px 10px; border-bottom: 1px solid #e0e0e0; }}
    th {{ background: #f6f6f6; font-weight: 600; }}
    .pass {{ color: #1b5e20; font-weight: 600; }}
    .fail {{ color: #b71c1c; font-weight: 600; }}
    .num {{ font-variant-numeric: tabular-nums; }}
    .footer {{ margin-top: 24px; color: #6a6a6a; font-size: 12px; }}
  </style>
</head>
<body>
  <h1>{title}</h1>
  <div class="meta">Generated {generated_at} · {n_runs} runs</div>
  <div>Overall verdict: <span class="{verdict_class} verdict">{verdict}</span></div>
{blocking}
  <table>
    <thead>
      <tr>
        <th>Grader</th>
        <th>Version</th>
        <th>N runs</th>
        <th>N passed</th>
        <th>N failed</th>
        <th>Pass rate</th>
        <th>Failure examples</th>
      </tr>
    </thead>
    <tbody>
{rows}
    </tbody>
  </table>
  <div class="footer">SPEC §18.5 / §41.11 — security evaluation. Failure of any guardrail is a hard block.</div>
</body>
</html>
"""

_ROW = """      <tr>
        <td>{grader_id}</td>
        <td>{version}</td>
        <td class="num">{n_runs}</td>
        <td class="num">{n_passed}</td>
        <td class="num {cls}">{n_failed}</td>
        <td class="num">{pass_rate}</td>
        <td>{examples}</td>
      </tr>"""

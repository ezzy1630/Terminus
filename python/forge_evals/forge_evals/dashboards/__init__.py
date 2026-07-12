"""SPEC §41.6 dashboards.

Self-contained HTML dashboards for cohort summaries, ablation reports, and
security reports. No external CSS/JS dependencies.
"""

from __future__ import annotations

from .cohort_dashboard import cohort_dashboard_html, write_cohort_dashboard
from .feature_contribution import (
    AblationContribution,
    AblationReport,
    ablation_report_html,
    compute_ablation_contributions,
    write_ablation_report,
)
from .security_report import (
    SecurityGraderSummary,
    SecurityReport,
    compute_security_report,
    security_report_html,
    write_security_report,
)

__all__ = [
    "AblationContribution",
    "AblationReport",
    "SecurityGraderSummary",
    "SecurityReport",
    "ablation_report_html",
    "cohort_dashboard_html",
    "compute_ablation_contributions",
    "compute_security_report",
    "security_report_html",
    "write_ablation_report",
    "write_cohort_dashboard",
    "write_security_report",
]

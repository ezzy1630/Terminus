"""Tier 3 — the scheduled baseline-vs-candidate cohort comparison.

Takes two run sets (baseline arm, candidate arm) over the same held-out
cohort and produces the causal comparison artifact:

- partition enforcement (blocked cells fail closed; holdout cells must be
  stamped);
- per-slice cohort metrics for both arms with bootstrap CIs;
- paired per-(suite, task, seed) deltas with McNemar and effect sizes;
- automatic trajectory, context-manifest, and tool-sequence comparisons per
  pair;
- reliability gates (false-completion, stuck-state, verification false-block,
  cache-prefix survival) computed from the same evidence the promotion gate
  consumes.

The comparison never claims promotion by itself. It produces the evidence
the promotion gate reads.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .cohort_metrics import CohortMetrics, cohort_metrics
from .holdout import PartitionRegistry, load_partition_registry
from .run_record import RunRecord
from .statistics.bootstrap import bootstrap_ci
from .statistics.paired import mc_nemar
from .trajectory_diff import diff_trajectories

__all__ = [
    "CohortComparison",
    "PairComparison",
    "SliceComparison",
    "compare_cohort_runs",
]


@dataclass
class PairComparison:
    """One matched (suite, task, seed) cell across the two arms."""

    suite: str
    task: str
    seed: int
    baseline: RunRecord
    candidate: RunRecord
    identity_issue: str | None
    trajectory_summary: list[str] = field(default_factory=list)
    tools_diverged: bool = False

    @property
    def delta(self) -> float:
        return float(self.candidate.success) - float(self.baseline.success)


@dataclass
class SliceComparison:
    """Both arms' metrics plus paired statistics for one cohort slice."""

    suite: str
    baseline: CohortMetrics
    candidate: CohortMetrics
    pairs: int
    resolved_delta: float
    resolved_delta_ci_low: float | None
    resolved_delta_ci_high: float | None
    mcnemar_p_value: float | None
    cost_delta_pct: float | None
    latency_p95_delta_pct: float | None
    verdict: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "suite": self.suite,
            "pairs": self.pairs,
            "baseline": self.baseline.to_dict(),
            "candidate": self.candidate.to_dict(),
            "resolved_delta": self.resolved_delta,
            "resolved_delta_ci": (
                [self.resolved_delta_ci_low, self.resolved_delta_ci_high]
                if self.resolved_delta_ci_low is not None
                else None
            ),
            "mcnemar_p_value": self.mcnemar_p_value,
            "cost_delta_pct": self.cost_delta_pct,
            "latency_p95_delta_pct": self.latency_p95_delta_pct,
            "verdict": self.verdict,
        }


@dataclass
class CohortComparison:
    """The full causal comparison artifact."""

    report: str = "terminus.cohort.comparison/v1"
    eligible: bool = False
    issues: list[str] = field(default_factory=list)
    slices: list[SliceComparison] = field(default_factory=list)
    pair_count: int = 0
    unpaired_baseline: list[str] = field(default_factory=list)
    unpaired_candidate: list[str] = field(default_factory=list)
    identity_locked: bool = False
    partitions: dict[str, Any] = field(default_factory=dict)
    reliability_gates: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "report": self.report,
            "eligible": self.eligible,
            "issues": list(self.issues),
            "slices": [s.to_dict() for s in self.slices],
            "pair_count": self.pair_count,
            "unpaired_baseline": list(self.unpaired_baseline),
            "unpaired_candidate": list(self.unpaired_candidate),
            "identity_locked": self.identity_locked,
            "partitions": dict(self.partitions),
            "reliability_gates": dict(self.reliability_gates),
        }

    def summary_lines(self) -> list[str]:
        """Human-readable summary (the markdown report body)."""
        lines = [
            f"# Cohort comparison ({'ELIGIBLE' if self.eligible else 'NOT ELIGIBLE'})",
            "",
            f"Pairs: {self.pair_count} · slices: {len(self.slices)} · "
            f"unpaired: baseline={len(self.unpaired_baseline)} candidate={len(self.unpaired_candidate)}",
        ]
        if self.issues:
            lines.extend(["", "## Issues"] + [f"- {issue}" for issue in self.issues])
        lines.append("")
        lines.append("## Slices")
        for slice_cmp in self.slices:
            lines.append(
                f"- **{slice_cmp.suite}**: pairs={slice_cmp.pairs} "
                f"resolved Δ={slice_cmp.resolved_delta:+.3f} verdict={slice_cmp.verdict}"
            )
            for arm_name, metrics in (
                ("baseline", slice_cmp.baseline),
                ("candidate", slice_cmp.candidate),
            ):
                resolved = metrics.cells.get("resolved_task_rate")
                if resolved is not None:
                    ci = (
                        f" [{resolved.ci_low:.3f}, {resolved.ci_high:.3f}]"
                        if resolved.ci_low is not None
                        else ""
                    )
                    lines.append(
                        f"  - {arm_name} resolved: {resolved.value:.3f}{ci} (n={metrics.runs})"
                    )
        lines.append("")
        lines.append("## Reliability gates")
        for name, gate in sorted(self.reliability_gates.items()):
            lines.append(f"- **{name}**: {gate['status']} — {gate['detail']}")
        return lines


def _key(record: RunRecord) -> tuple[str, str, int]:
    return (record.suite, record.task, record.random_seed)


def _identity_issue(baseline: RunRecord, candidate: RunRecord) -> str | None:
    b = baseline.evaluation_identity
    c = candidate.evaluation_identity
    if b is None or c is None:
        return "one side has no evaluation identity"
    if b.model_fixed_key != c.model_fixed_key:
        return "model-fixed identity mismatch"
    return None


def _rate_delta_ci(
    baseline_indicators: list[float],
    candidate_indicators: list[float],
    confidence: float = 0.95,
) -> tuple[float, float | None, float | None]:
    """Delta of means with a paired-bootstrap CI over matched cells."""
    if len(baseline_indicators) != len(candidate_indicators) or not baseline_indicators:
        return float("nan"), None, None
    deltas = [c - b for b, c in zip(baseline_indicators, candidate_indicators, strict=True)]
    mean = sum(deltas) / len(deltas)
    if len(deltas) < 2:
        return mean, None, None
    ci_low, ci_high = bootstrap_ci(deltas, _mean, confidence_level=confidence)
    return mean, ci_low, ci_high


def _mean(sample: Any) -> float:
    values = list(sample)
    return sum(values) / len(values) if values else float("nan")


def _pct_delta(baseline: float | None, candidate: float | None) -> float | None:
    if baseline is None or candidate is None or baseline == 0:
        return None
    return (candidate - baseline) / baseline * 100.0


def _reliability_gates(
    slices: list[SliceComparison],
    *,
    false_completion_margin: float = 0.02,
    stuck_state_margin: float = 0.02,
    false_block_margin: float = 0.02,
    cache_survival_margin: float = 0.05,
) -> dict[str, dict[str, Any]]:
    """Aggregate reliability gates across slices (fail on any slice breach).

    A candidate must not be more false-completion-prone, more stuck, more
    verification-block-happy, or worse at cache-prefix survival than the
    baseline it claims to improve. Margins tolerate small-sample noise.
    """
    gates: dict[str, dict[str, Any]] = {}
    for name, metric, margin, direction in (
        ("false_completion", "false_completion_rate", false_completion_margin, "increase"),
        ("stuck_state", "stuck_state_rate", stuck_state_margin, "increase"),
        (
            "verification_false_block",
            "verification_false_block_rate",
            false_block_margin,
            "increase",
        ),
        ("cache_prefix_survival", "cache_prefix_survival", cache_survival_margin, "decrease"),
    ):
        worst: tuple[str, float] | None = None
        for slice_cmp in slices:
            base_cell = slice_cmp.baseline.cells.get(metric)
            cand_cell = slice_cmp.candidate.cells.get(metric)
            if base_cell is None or cand_cell is None:
                continue
            if base_cell.value is None or cand_cell.value is None:
                continue
            delta = cand_cell.value - base_cell.value
            breached = delta > margin if direction == "increase" else delta < -margin
            if breached and (worst is None or abs(delta) > abs(worst[1])):
                worst = (slice_cmp.suite, delta)
        if worst is None:
            gates[name] = {
                "status": "pass",
                "detail": f"no slice breaches the {direction} margin of {margin}",
            }
        else:
            gates[name] = {
                "status": "fail",
                "detail": f"slice {worst[0]} regressed by {worst[1]:+.4f} "
                f"(allowed {direction} margin {margin})",
            }
    return gates


def _slice_verdict(resolved_delta: float, ci_low: float | None, ci_high: float | None) -> str:
    if ci_low is None or ci_high is None:
        return "inconclusive"
    if ci_low > 0:
        return "improvement"
    if ci_high < 0:
        return "regression"
    return "no_change"


def compare_cohort_runs(
    baseline_records: list[RunRecord],
    candidate_records: list[RunRecord],
    *,
    registry: PartitionRegistry | None = None,
    output_dir: Path | str | None = None,
    confidence: float = 0.95,
) -> CohortComparison:
    """Run the causal comparison over two run sets."""
    comparison = CohortComparison()
    if registry is None:
        registry = load_partition_registry()

    # Partition enforcement first: blocked or unstamped holdout cells make
    # the whole comparison inadmissible.
    issues = registry.enforcement_issues(baseline_records + candidate_records)
    if issues:
        comparison.issues.extend(issues)

    baseline_by_key = {_key(r): r for r in baseline_records}
    candidate_by_key = {_key(r): r for r in candidate_records}
    shared = sorted(set(baseline_by_key) & set(candidate_by_key))
    comparison.pair_count = len(shared)
    comparison.unpaired_baseline = sorted(
        f"{s}/{t}/{seed}" for s, t, seed in set(baseline_by_key) - set(candidate_by_key)
    )
    comparison.unpaired_candidate = sorted(
        f"{s}/{t}/{seed}" for s, t, seed in set(candidate_by_key) - set(baseline_by_key)
    )
    if comparison.unpaired_baseline:
        comparison.issues.append(
            f"{len(comparison.unpaired_baseline)} baseline cells without a candidate match"
        )
    if comparison.unpaired_candidate:
        comparison.issues.append(
            f"{len(comparison.unpaired_candidate)} candidate cells without a baseline match"
        )

    slices: dict[str, list[PairComparison]] = {}
    identity_locked = True
    for suite, task, seed in shared:
        baseline = baseline_by_key[(suite, task, seed)]
        candidate = candidate_by_key[(suite, task, seed)]
        issue = _identity_issue(baseline, candidate)
        if issue is not None:
            identity_locked = False
        diff = diff_trajectories(baseline.to_dict(), candidate.to_dict())
        pair = PairComparison(
            suite=suite,
            task=task,
            seed=seed,
            baseline=baseline,
            candidate=candidate,
            identity_issue=issue,
            trajectory_summary=diff.summary_lines(),
            tools_diverged=diff.tool_diff.first_divergence
            < max(len(diff.tool_diff.baseline_tools), len(diff.tool_diff.candidate_tools)),
        )
        slices.setdefault(suite, []).append(pair)
    comparison.identity_locked = identity_locked

    slices_out: list[SliceComparison] = []
    for suite, pairs in sorted(slices.items()):
        baseline_slice = [p.baseline for p in pairs]
        candidate_slice = [p.candidate for p in pairs]
        baseline_metrics = cohort_metrics(
            baseline_slice, slice_name=f"{suite}/baseline", confidence=confidence
        )
        candidate_metrics = cohort_metrics(
            candidate_slice, slice_name=f"{suite}/candidate", confidence=confidence
        )
        delta, ci_low, ci_high = _rate_delta_ci(
            [float(p.baseline.success) for p in pairs],
            [float(p.candidate.success) for p in pairs],
            confidence=confidence,
        )
        mcnemar = (
            mc_nemar(
                [p.baseline.success for p in pairs],
                [p.candidate.success for p in pairs],
            )
            if len(pairs) >= 2
            else None
        )
        cost_delta = _pct_delta(
            baseline_metrics.cells["cost_per_run_usd"].value,
            candidate_metrics.cells["cost_per_run_usd"].value,
        )
        latency_delta = _pct_delta(
            baseline_metrics.cells["latency_ms_p95"].value,
            candidate_metrics.cells["latency_ms_p95"].value,
        )
        slices_out.append(
            SliceComparison(
                suite=suite,
                baseline=baseline_metrics,
                candidate=candidate_metrics,
                pairs=len(pairs),
                resolved_delta=delta,
                resolved_delta_ci_low=ci_low,
                resolved_delta_ci_high=ci_high,
                mcnemar_p_value=mcnemar.p_value if mcnemar is not None else None,
                cost_delta_pct=cost_delta,
                latency_p95_delta_pct=latency_delta,
                verdict=_slice_verdict(delta, ci_low, ci_high),
            )
        )
    comparison.slices = slices_out
    comparison.reliability_gates = _reliability_gates(slices_out)
    comparison.eligible = (
        not comparison.issues and comparison.pair_count > 0 and identity_locked and bool(slices_out)
    )

    if output_dir is not None:
        out = Path(output_dir)
        out.mkdir(parents=True, exist_ok=True)
        (out / "cohort-comparison.json").write_text(
            json.dumps(comparison.to_dict(), indent=2, sort_keys=True), encoding="utf-8"
        )
        (out / "cohort-comparison.md").write_text(
            "\n".join(comparison.summary_lines()) + "\n", encoding="utf-8"
        )
    return comparison

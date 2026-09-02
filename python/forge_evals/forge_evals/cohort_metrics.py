"""Tier 3 — cohort-level causal metrics over paired run sets.

Computes the metric set the causal evaluation system reports for a
baseline-vs-candidate cohort comparison, per side, sliced by cohort and task
archetype, with repetitions and bootstrap confidence intervals:

    quality          resolved-task rate, false-completion rate
    cost_and_latency median/p95 wall-clock latency, token breakdowns
                     (input, cached-input, reasoning, output), cost per
                     resolved task, tool calls per resolved task,
                     verification cost share
    reliability      provider retries, lifecycle recoveries, stuck-state
                     rate, verification false-block rate, tool-error rate
    context          context-compilation latency, selected-token count,
                     cache-prefix survival between turns

Everything is derived from the immutable fields the run record already
carries. A metric that a record cannot support is ``None`` — "not measured"
never degrades into a fabricated zero.
"""

from __future__ import annotations

import itertools
import math
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from .run_record import Outcome, RunRecord
from .statistics.bootstrap import bootstrap_ci

__all__ = [
    "CohortMetrics",
    "MetricCell",
    "cohort_metrics",
    "percentile",
]

_STUCK_OUTCOMES = {Outcome.ERROR, Outcome.TIMEOUT, Outcome.MISSING}

# Trajectory events that count as a lifecycle recovery: the control plane
# scheduled a repair, resumed a stranded turn, or recovered after a fault.
_RECOVERY_EVENTS = frozenset(
    {
        "task.repair_scheduled",
        "turn.repair_pending",
        "turn.repairing",
    }
)


def percentile(values: list[float], p: float) -> float:
    """Linear-interpolated percentile of ``values`` (p in [0, 100])."""
    if not values:
        return float("nan")
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    rank = (p / 100.0) * (len(ordered) - 1)
    lower = math.floor(rank)
    upper = math.ceil(rank)
    if lower == upper:
        return ordered[lower]
    fraction = rank - lower
    return ordered[lower] * (1.0 - fraction) + ordered[upper] * fraction


@dataclass(frozen=True)
class MetricCell:
    """One reported metric for one slice of one arm."""

    metric: str
    value: float | None
    n: int
    ci_low: float | None = None
    ci_high: float | None = None
    unit: str = "ratio"
    note: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "metric": self.metric,
            "value": self.value,
            "n": self.n,
            "ci_low": self.ci_low,
            "ci_high": self.ci_high,
            "unit": self.unit,
            "note": self.note,
        }


@dataclass
class CohortMetrics:
    """All reported metrics for one arm of one cohort slice."""

    slice_name: str
    runs: int
    cells: dict[str, MetricCell] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "slice": self.slice_name,
            "runs": self.runs,
            "metrics": {name: cell.to_dict() for name, cell in sorted(self.cells.items())},
        }


def _rate(
    runs: list[RunRecord],
    predicate: Any,
    *,
    metric: str,
    confidence: float = 0.95,
    note: str = "",
) -> MetricCell:
    """A ratio metric with a bootstrap CI over the indicator sample."""
    sample = [1.0 if predicate(record) else 0.0 for record in runs]
    if not runs:
        return MetricCell(metric=metric, value=None, n=0, note="no runs")
    value = sum(sample) / len(sample)
    ci_low, ci_high = bootstrap_ci(sample, _mean, confidence_level=confidence)
    return MetricCell(
        metric=metric,
        value=value,
        n=len(runs),
        ci_low=ci_low,
        ci_high=ci_high,
        note=note,
    )


def _mean(sample: Any) -> float:
    values = list(sample)
    return sum(values) / len(values) if values else float("nan")


def _numeric_cell(
    runs: list[RunRecord],
    extract: Any,
    *,
    metric: str,
    stat: Any = _mean,
    unit: str = "value",
    confidence: float = 0.95,
    note: str = "",
) -> MetricCell:
    """A numeric metric over the records where the value is measured."""
    sample = [value for record in runs if (value := extract(record)) is not None]
    if not sample:
        return MetricCell(metric=metric, value=None, n=0, unit=unit, note="not measured on any run")
    value = stat(sample)
    ci_low, ci_high = bootstrap_ci(sample, stat, confidence_level=confidence)
    return MetricCell(
        metric=metric,
        value=value,
        n=len(sample),
        ci_low=ci_low,
        ci_high=ci_high,
        unit=unit,
        note=note,
    )


def _is_resolved(record: RunRecord) -> bool:
    return record.success


def _false_completion(record: RunRecord) -> bool:
    """The harness admitted a completion the independent graders rejected."""
    return (
        record.harness_verdict.get("admitted") is True
        and bool(record.grader_results)
        and not record.success
    )


def _verification_false_block(record: RunRecord) -> bool:
    """The harness verification failed (or never admitted) a grader-passing run.

    ``admitted is False`` means the verification plan ran and rejected the
    workspace; ``admitted is None`` (not runnable / unknown) is deliberately
    *not* counted as a false block — it is reported separately.
    """
    return (
        record.harness_verdict.get("admitted") is False
        and bool(record.grader_results)
        and record.success
    )


def _verification_ran(record: RunRecord) -> bool:
    status = str(record.harness_verdict.get("status") or "")
    return status not in {"unknown", ""} and record.harness_verdict.get("admitted") is not None


def _provider_retries(record: RunRecord) -> int | None:
    """Attempts beyond the first, summed over the run's turns."""
    attempts = record.attempts or []
    if not attempts:
        return None
    return max(0, len(attempts) - 1)


def _lifecycle_recoveries(record: RunRecord) -> int:
    count = record.repair_turns
    for event in record.trajectory or []:
        if event.get("event_type") in _RECOVERY_EVENTS:
            count += 1
    return count


def _is_stuck(record: RunRecord) -> bool:
    """A run that never reached a graded terminal state.

    ERROR (the loop died), TIMEOUT (the turn was killed), and MISSING (the
    run vanished — never silently dropped from a cohort) are the stuck
    outcomes. Structural defects like a missing ``end`` timestamp are exit-
    gate failures, not stuck states, and are reported there.
    """
    return record.outcome in _STUCK_OUTCOMES


def _compile_latency_ms(record: RunRecord) -> float | None:
    """Median context-compilation latency, from persisted trajectory events.

    For every ``context.manifest_persisted`` event with a timestamp, the
    latency is the time since the previous lifecycle event. Runs without
    timestamped lifecycle events report ``None``.
    """
    events = record.trajectory or []
    latencies: list[float] = []
    previous_ts: datetime | None = None
    for event in events:
        ts = event.get("ts")
        if isinstance(ts, str):
            try:
                current = datetime.fromisoformat(ts)
            except ValueError:
                current = None
        else:
            current = None
        if (
            event.get("event_type") == "context.manifest_persisted"
            and previous_ts is not None
            and current is not None
        ):
            latencies.append((current - previous_ts).total_seconds() * 1000.0)
        if current is not None:
            previous_ts = current
    if not latencies:
        return None
    return percentile(latencies, 50.0)


def _selected_tokens(record: RunRecord) -> int | None:
    """Selected tokens across the run's context manifests, when reported."""
    manifests = record.context_manifests or []
    if not manifests:
        return None
    total = 0
    seen = False
    for manifest in manifests:
        for key in (
            "selected_tokens",
            "total_selected_tokens",
            "tokens_selected",
            "selected_token_count",
        ):
            value = manifest.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                total += int(value)
                seen = True
                break
    return total if seen else None


def _cache_prefix_survival(record: RunRecord) -> float | None:
    """Share of consecutive attempt pairs whose cache prefix survived.

    An attempt pair survives when the later attempt reports cached input
    tokens — the provider reused the previous turn's compiled prefix. Runs
    with fewer than two provider attempts report ``None``.
    """
    attempts = record.attempts or []
    if len(attempts) < 2:
        return None
    survived = 0
    for previous, current in itertools.pairwise(attempts):
        cached_prev = _attempt_int(previous, "cached_input_tokens")
        cached_current = _attempt_int(current, "cached_input_tokens")
        if cached_current > 0 and cached_current >= min(cached_prev, cached_current):
            survived += 1
    return survived / (len(attempts) - 1)


def _attempt_int(attempt: dict[str, Any] | Any, key: str) -> int:
    value = attempt.get(key) if isinstance(attempt, dict) else getattr(attempt, key, None)
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else 0


def _total_cost(record: RunRecord) -> float | None:
    return None if record.cost is None else record.cost.computed_usd


def _total_tokens(record: RunRecord) -> int | None:
    total = record.tokens_input_fresh + record.tokens_input_cached + record.tokens_output
    return total if total > 0 else None


def cohort_metrics(
    runs: list[RunRecord],
    *,
    slice_name: str,
    confidence: float = 0.95,
) -> CohortMetrics:
    """Compute the full metric set for one arm of one cohort slice."""
    metrics = CohortMetrics(slice_name=slice_name, runs=len(runs))
    if not runs:
        return metrics

    resolved = [record for record in runs if _is_resolved(record)]
    metrics.cells["resolved_task_rate"] = _rate(
        runs, _is_resolved, metric="resolved_task_rate", confidence=confidence
    )
    metrics.cells["false_completion_rate"] = _rate(
        runs,
        _false_completion,
        metric="false_completion_rate",
        confidence=confidence,
        note="harness admitted a completion the graders rejected",
    )
    metrics.cells["stuck_state_rate"] = _rate(
        runs,
        _is_stuck,
        metric="stuck_state_rate",
        confidence=confidence,
        note="runs that never reached a graded terminal state",
    )
    metrics.cells["verification_false_block_rate"] = _rate(
        runs,
        _verification_false_block,
        metric="verification_false_block_rate",
        confidence=confidence,
        note="verification rejected a grader-passing workspace",
    )

    metrics.cells["latency_ms_median"] = _numeric_cell(
        [r for r in runs if r.wall_clock_ms is not None],
        lambda r: float(r.wall_clock_ms) if r.wall_clock_ms is not None else None,
        metric="latency_ms_median",
        stat=lambda sample: percentile(list(sample), 50.0),
        unit="ms",
        confidence=confidence,
    )
    metrics.cells["latency_ms_p95"] = _numeric_cell(
        [r for r in runs if r.wall_clock_ms is not None],
        lambda r: float(r.wall_clock_ms) if r.wall_clock_ms is not None else None,
        metric="latency_ms_p95",
        stat=lambda sample: percentile(list(sample), 95.0),
        unit="ms",
        confidence=confidence,
    )
    for name, extract in (
        (
            "tokens_input_fresh",
            lambda r: float(r.tokens_input_fresh) if r.tokens_input_fresh else None,
        ),
        (
            "tokens_input_cached",
            lambda r: float(r.tokens_input_cached) if r.tokens_input_cached else None,
        ),
        ("tokens_reasoning", lambda r: float(r.tokens_reasoning) if r.tokens_reasoning else None),
        ("tokens_output", lambda r: float(r.tokens_output) if r.tokens_output else None),
    ):
        metrics.cells[name] = _numeric_cell(
            runs, extract, metric=name, unit="tokens", confidence=confidence
        )

    metrics.cells["cost_per_run_usd"] = _numeric_cell(
        runs,
        _total_cost,
        metric="cost_per_run_usd",
        unit="usd",
        confidence=confidence,
    )

    def _cost_per_resolved(values: Any) -> float:
        return _mean(values) if resolved else float("nan")

    cost_sample = [c for r in runs if (c := _total_cost(r)) is not None]
    if resolved and cost_sample:
        value = sum(cost_sample) / len(resolved)
        ci_low, ci_high = bootstrap_ci(cost_sample, _cost_per_resolved, confidence_level=confidence)
        metrics.cells["cost_per_resolved_task_usd"] = MetricCell(
            metric="cost_per_resolved_task_usd",
            value=value,
            n=len(cost_sample),
            ci_low=ci_low,
            ci_high=ci_high,
            unit="usd",
        )
    else:
        metrics.cells["cost_per_resolved_task_usd"] = MetricCell(
            metric="cost_per_resolved_task_usd",
            value=None,
            n=0,
            unit="usd",
            note="no resolved tasks or no cost accounting",
        )

    def _steps_per_resolved(values: Any) -> float:
        return _mean(values) if resolved else float("nan")

    steps_sample = [float(r.steps) for r in runs if r.steps]
    if resolved and steps_sample:
        ci_low, ci_high = bootstrap_ci(
            steps_sample, _steps_per_resolved, confidence_level=confidence
        )
        metrics.cells["tool_calls_per_resolved_task"] = MetricCell(
            metric="tool_calls_per_resolved_task",
            value=sum(steps_sample) / len(resolved),
            n=len(steps_sample),
            ci_low=ci_low,
            ci_high=ci_high,
            unit="calls",
        )
    else:
        metrics.cells["tool_calls_per_resolved_task"] = MetricCell(
            metric="tool_calls_per_resolved_task",
            value=None,
            n=0,
            unit="calls",
            note="no resolved tasks or no step accounting",
        )

    verification_runs = [r for r in runs if _verification_ran(r)]
    if resolved:
        verification_cost = sum(c for r in verification_runs if (c := _total_cost(r)) is not None)
        metrics.cells["verification_cost_share_usd_per_run"] = MetricCell(
            metric="verification_cost_share_usd_per_run",
            value=verification_cost / len(runs),
            n=len(verification_runs),
            unit="usd",
            note="cost of runs that executed a verification plan, averaged over all runs",
        )
    else:
        metrics.cells["verification_cost_share_usd_per_run"] = MetricCell(
            metric="verification_cost_share_usd_per_run",
            value=None,
            n=len(verification_runs),
            unit="usd",
            note="no resolved tasks; verification cost share not meaningful",
        )

    metrics.cells["provider_retries_per_run"] = _numeric_cell(
        runs,
        lambda r: float(v) if (v := _provider_retries(r)) is not None else None,
        metric="provider_retries_per_run",
        unit="retries",
        confidence=confidence,
    )
    metrics.cells["lifecycle_recoveries_per_run"] = _numeric_cell(
        runs,
        lambda r: float(_lifecycle_recoveries(r)) if r.trajectory or r.repair_turns else None,
        metric="lifecycle_recoveries_per_run",
        unit="recoveries",
        confidence=confidence,
    )
    metrics.cells["tool_error_rate"] = _numeric_cell(
        [r for r in runs if r.tool_error_rate is not None],
        lambda r: float(r.tool_error_rate) if r.tool_error_rate is not None else None,
        metric="tool_error_rate",
        confidence=confidence,
    )

    metrics.cells["context_compilation_latency_ms"] = _numeric_cell(
        runs,
        lambda r: (lambda v: v if v is not None else None)(_compile_latency_ms(r)),
        metric="context_compilation_latency_ms",
        unit="ms",
        stat=lambda sample: percentile(list(sample), 50.0),
        confidence=confidence,
        note="median over turns, from persisted lifecycle events; None when events lack timestamps",
    )
    metrics.cells["context_selected_tokens"] = _numeric_cell(
        runs,
        lambda r: float(v) if (v := _selected_tokens(r)) is not None else None,
        metric="context_selected_tokens",
        unit="tokens",
        confidence=confidence,
        note="summed over the run's persisted context manifests",
    )
    metrics.cells["cache_prefix_survival"] = _numeric_cell(
        [r for r in runs if len(r.attempts or []) >= 2],
        lambda r: (lambda v: v if v is not None else None)(_cache_prefix_survival(r)),
        metric="cache_prefix_survival",
        confidence=confidence,
        note="share of consecutive attempt pairs where the provider reused the cached prefix",
    )
    metrics.cells["repair_turns_per_run"] = _numeric_cell(
        [r for r in runs if r.repair_turns],
        lambda r: float(r.repair_turns) if r.repair_turns else None,
        metric="repair_turns_per_run",
        unit="turns",
        confidence=confidence,
    )
    return metrics

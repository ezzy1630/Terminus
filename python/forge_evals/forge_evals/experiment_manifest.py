"""SPEC §18.6 / §41.7 experiment & change manifests.

Every harness change ships with a *change manifest* (SPEC §18.6 — AHE-style)
and every feature experiment ships with an *experiment manifest* (SPEC §41.7).
After the run, a *decision* is attached: ``promote | retain_experimental |
revise | rollback``.

These dataclasses are the canonical Python representation. They serialize to
YAML (matching the SPEC schema) and to JSON for storage alongside run records.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

import yaml

__all__ = [
    "ChangeManifest",
    "Decision",
    "ExperimentManifest",
    "ObservedDeltas",
    "PromotionRule",
    "RollbackCondition",
    "SamplePlan",
    "StoppingRule",
]


class Decision(str, Enum):
    """Post-run decision attached to a change manifest (SPEC §18.6)."""

    PROMOTE = "promote"
    RETAIN_EXPERIMENTAL = "retain_experimental"
    REVISE = "revise"
    ROLLBACK = "rollback"


@dataclass(frozen=True)
class SamplePlan:
    """Pre-registered sample plan (SPEC §41.6, §41.7).

    Holds the per-cohort task and seed counts. Stopping rule and
    randomization are recorded separately so multiple sample plans can
    share the same stopping behaviour.
    """

    cohorts: list[str]
    tasks_per_cohort: int
    seeds_per_task: int
    holdout_cohorts: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.tasks_per_cohort <= 0:
            raise ValueError("tasks_per_cohort must be > 0")
        if self.seeds_per_task <= 0:
            raise ValueError("seeds_per_task must be > 0")

    @property
    def total_runs(self) -> int:
        """Total number of runs the plan implies (excluding holdouts)."""
        included = [c for c in self.cohorts if c not in self.holdout_cohorts]
        return len(included) * self.tasks_per_cohort * self.seeds_per_task


@dataclass(frozen=True)
class StoppingRule:
    """Pre-registered stopping rule (SPEC §41.6)."""

    kind: str  # "fixed" | "sequential" | "group_sequential"
    max_runs: int
    min_runs: int = 1
    alpha: float = 0.05
    power: float = 0.8
    early_stop_on_significant: bool = False

    def __post_init__(self) -> None:
        if self.max_runs < self.min_runs:
            raise ValueError("max_runs < min_runs")
        if not 0 < self.alpha < 1:
            raise ValueError("alpha must be in (0,1)")
        if not 0 < self.power < 1:
            raise ValueError("power must be in (0,1)")


@dataclass(frozen=True)
class PromotionRule:
    """Promotion gate criteria for an experiment (SPEC §41.12)."""

    primary_cohort: str
    min_effect_size: float  # Cohen's d / Hedges' g threshold
    noninferiority_margin: float  # for "no regression" cohorts
    max_regression_cohorts: list[str]  # cohorts where regressions are blocked
    security_guardrails: list[str]  # ids of safety graders that MUST pass
    cost_guardrails: list[str]  # ids of cost guardrails (max delta %)
    confidence_level: float = 0.95

    def __post_init__(self) -> None:
        if not 0 < self.confidence_level < 1:
            raise ValueError("confidence_level must be in (0,1)")


@dataclass(frozen=True)
class RollbackCondition:
    """A single rollback trigger (SPEC §18.6)."""

    metric: str
    threshold: str  # e.g. ">= -0.05" or "fail_rate > 0"
    action: str = "rollback"

    def matches(self, observed: dict[str, float]) -> bool:
        """Evaluate this condition against a dict of observed metric → value.

        ``threshold`` must be of the form ``"<op> <number>"`` where op is one
        of ``>=``, ``<=``, ``>``, ``<``, ``==``, ``!=``. Returns ``False`` if
        the metric is not present in ``observed``.
        """
        if self.metric not in observed:
            return False
        return _eval_threshold(observed[self.metric], self.threshold)


def _eval_threshold(value: float, threshold: str) -> bool:
    """Evaluate ``value`` against a threshold string like ``">= -0.05"``."""
    parts = threshold.strip().split()
    if len(parts) != 2:
        raise ValueError(f"threshold must be '<op> <number>', got {threshold!r}")
    op, num = parts[0], float(parts[1])
    return {
        ">=": value >= num,
        "<=": value <= num,
        ">": value > num,
        "<": value < num,
        "==": value == num,
        "!=": value != num,
    }[op]


@dataclass
class ObservedDeltas:
    """Post-run observed deltas attached to a change manifest (SPEC §18.6)."""

    primary_metric_delta: float | None = None
    secondary_metric_deltas: dict[str, float] = field(default_factory=dict)
    confidence_intervals: dict[str, tuple[float, float]] = field(default_factory=dict)
    security_guardrail_results: dict[str, bool] = field(default_factory=dict)
    cost_guardrail_results: dict[str, float] = field(default_factory=dict)
    regression_cohorts: list[str] = field(default_factory=list)
    notes: str = ""


@dataclass
class ChangeManifest:
    """SPEC §18.6 AHE-style change manifest."""

    hypothesis: str
    target_cohort: str
    changed_components: list[str]
    predicted_improvements: dict[str, float] = field(default_factory=dict)
    predicted_regressions: dict[str, float] = field(default_factory=dict)
    metrics: list[str] = field(default_factory=list)
    budget: dict[str, Any] = field(default_factory=dict)
    seeds: int = 3
    holdouts: list[str] = field(default_factory=list)
    rollback_condition: RollbackCondition | None = None
    owner: str = ""
    # Filled in after the run.
    observed: ObservedDeltas | None = None
    decision: Decision | None = None
    decision_reason: str = ""

    def attach_observed(self, observed: ObservedDeltas) -> None:
        """Attach post-run observed deltas."""
        self.observed = observed

    def make_decision(self, decision: Decision, reason: str = "") -> None:
        """Attach the post-run decision."""
        self.decision = decision
        self.decision_reason = reason

    def should_rollback(self) -> bool:
        """True iff the rollback condition is set and matches observed deltas."""
        if self.rollback_condition is None or self.observed is None:
            return False
        observed_map: dict[str, float] = {}
        if self.observed.primary_metric_delta is not None:
            observed_map["primary"] = self.observed.primary_metric_delta
        observed_map.update(self.observed.secondary_metric_deltas)
        observed_map.update(self.observed.cost_guardrail_results)
        # Substitute the configured metric name back into a flat lookup.
        return self.rollback_condition.matches(
            {"primary": observed_map.get("primary", 0.0), **observed_map}
        )

    def to_yaml(self) -> str:
        """Serialize to a YAML string matching the SPEC §18.6 schema."""
        d = _to_plain_dict(self)
        return yaml.safe_dump(d, sort_keys=False, default_flow_style=False)

    def to_yaml_file(self, path: Path | str) -> Path:
        """Write to ``path`` as YAML."""
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(self.to_yaml(), encoding="utf-8")
        return p

    @classmethod
    def from_yaml(cls, text_or_path: str | Path) -> ChangeManifest:
        """Read from a YAML string or path."""
        if isinstance(text_or_path, Path):
            text = text_or_path.read_text(encoding="utf-8")
        else:
            p = Path(text_or_path)
            text = p.read_text(encoding="utf-8") if p.exists() else text_or_path
        data = yaml.safe_load(text) or {}
        return cls._from_dict(data)

    @classmethod
    def _from_dict(cls, data: dict[str, Any]) -> ChangeManifest:
        rollback = None
        if data.get("rollback_condition"):
            rb = data["rollback_condition"]
            rollback = RollbackCondition(
                metric=rb["metric"],
                threshold=rb["threshold"],
                action=rb.get("action", "rollback"),
            )
        observed = None
        if data.get("observed"):
            od = data["observed"]
            cis = {k: tuple(v) for k, v in (od.get("confidence_intervals") or {}).items()}
            observed = ObservedDeltas(
                primary_metric_delta=od.get("primary_metric_delta"),
                secondary_metric_deltas=od.get("secondary_metric_deltas", {}) or {},
                confidence_intervals=cis,
                security_guardrail_results=od.get("security_guardrail_results", {}) or {},
                cost_guardrail_results=od.get("cost_guardrail_results", {}) or {},
                regression_cohorts=od.get("regression_cohorts", []) or [],
                notes=od.get("notes", ""),
            )
        decision = None
        if data.get("decision"):
            decision = Decision(data["decision"])
        return cls(
            hypothesis=data["hypothesis"],
            target_cohort=data["target_cohort"],
            changed_components=list(data.get("changed_components", []) or []),
            predicted_improvements=data.get("predicted_improvements", {}) or {},
            predicted_regressions=data.get("predicted_regressions", {}) or {},
            metrics=list(data.get("metrics", []) or []),
            budget=data.get("budget", {}) or {},
            seeds=int(data.get("seeds", 3)),
            holdouts=list(data.get("holdouts", []) or []),
            rollback_condition=rollback,
            owner=data.get("owner", ""),
            observed=observed,
            decision=decision,
            decision_reason=data.get("decision_reason", ""),
        )


@dataclass
class ExperimentManifest:
    """SPEC §41.7 feature experiment manifest."""

    id: str
    hypothesis: str
    component: str
    baseline_version: str
    candidate_version: str
    cohorts: list[str]
    primary_metric: str
    secondary_metrics: list[str] = field(default_factory=list)
    safety_guardrails: list[str] = field(default_factory=list)
    cost_guardrails: list[str] = field(default_factory=list)
    sample_plan: SamplePlan | None = None
    randomization: str = "paired_block"  # SPEC §41.6 prefers paired comparisons
    stopping_rule: StoppingRule | None = None
    promotion_rule: PromotionRule | None = None
    owner: str = ""
    # Filled in after the experiment runs.
    decision: Decision | None = None
    decision_reason: str = ""

    def make_decision(self, decision: Decision, reason: str = "") -> None:
        """Attach the post-experiment decision."""
        self.decision = decision
        self.decision_reason = reason

    def to_yaml(self) -> str:
        """Serialize to a YAML string matching the SPEC §41.7 schema."""
        return yaml.safe_dump(_to_plain_dict(self), sort_keys=False, default_flow_style=False)

    def to_yaml_file(self, path: Path | str) -> Path:
        """Write to ``path`` as YAML."""
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(self.to_yaml(), encoding="utf-8")
        return p

    @classmethod
    def from_yaml(cls, text_or_path: str | Path) -> ExperimentManifest:
        """Read from a YAML string or path."""
        if isinstance(text_or_path, Path):
            text = text_or_path.read_text(encoding="utf-8")
        else:
            p = Path(text_or_path)
            text = p.read_text(encoding="utf-8") if p.exists() else text_or_path
        data = yaml.safe_load(text) or {}
        return cls._from_dict(data)

    @classmethod
    def _from_dict(cls, data: dict[str, Any]) -> ExperimentManifest:
        sp = None
        if data.get("sample_plan"):
            s = data["sample_plan"]
            sp = SamplePlan(
                cohorts=list(s.get("cohorts", []) or []),
                tasks_per_cohort=int(s.get("tasks_per_cohort", 0)),
                seeds_per_task=int(s.get("seeds_per_task", 0)),
                holdout_cohorts=list(s.get("holdout_cohorts", []) or []),
            )
        sr = None
        if data.get("stopping_rule"):
            r = data["stopping_rule"]
            sr = StoppingRule(
                kind=r.get("kind", "fixed"),
                max_runs=int(r.get("max_runs", 0)),
                min_runs=int(r.get("min_runs", 1)),
                alpha=float(r.get("alpha", 0.05)),
                power=float(r.get("power", 0.8)),
                early_stop_on_significant=bool(r.get("early_stop_on_significant", False)),
            )
        pr = None
        if data.get("promotion_rule"):
            p = data["promotion_rule"]
            pr = PromotionRule(
                primary_cohort=p["primary_cohort"],
                min_effect_size=float(p.get("min_effect_size", 0.0)),
                noninferiority_margin=float(p.get("noninferiority_margin", 0.0)),
                max_regression_cohorts=list(p.get("max_regression_cohorts", []) or []),
                security_guardrails=list(p.get("security_guardrails", []) or []),
                cost_guardrails=list(p.get("cost_guardrails", []) or []),
                confidence_level=float(p.get("confidence_level", 0.95)),
            )
        decision = None
        if data.get("decision"):
            decision = Decision(data["decision"])
        return cls(
            id=data["id"],
            hypothesis=data["hypothesis"],
            component=data["component"],
            baseline_version=data["baseline_version"],
            candidate_version=data["candidate_version"],
            cohorts=list(data.get("cohorts", []) or []),
            primary_metric=data["primary_metric"],
            secondary_metrics=list(data.get("secondary_metrics", []) or []),
            safety_guardrails=list(data.get("safety_guardrails", []) or []),
            cost_guardrails=list(data.get("cost_guardrails", []) or []),
            sample_plan=sp,
            randomization=data.get("randomization", "paired_block"),
            stopping_rule=sr,
            promotion_rule=pr,
            owner=data.get("owner", ""),
            decision=decision,
            decision_reason=data.get("decision_reason", ""),
        )


def _to_plain_dict(obj: Any) -> Any:
    """Recursively convert dataclasses + enums to plain JSON/YAML-safe values."""
    if isinstance(obj, Enum):
        return obj.value
    if hasattr(obj, "__dataclass_fields__"):
        return {k: _to_plain_dict(getattr(obj, k)) for k in obj.__dataclass_fields__}
    if isinstance(obj, dict):
        return {k: _to_plain_dict(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_to_plain_dict(v) for v in obj]
    return obj


def to_json(manifest: ChangeManifest | ExperimentManifest) -> str:
    """Serialize either manifest kind to a JSON string."""
    return json.dumps(_to_plain_dict(manifest), sort_keys=True, indent=2)

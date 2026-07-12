"""SPEC §41 / §14.2 model-routing research.

Investigates deterministic vs learned routing, cohort regression detection
across routed sub-models, and the trade-offs between routing accuracy and
added latency.

This module is *research-grade* — it provides the experiment scaffolding
but does not ship a trained router. The deterministic router
(``@forge/model-router``) is the production baseline; a learned router
must clear the promotion gate (SPEC §18.7, §41.12) before becoming
default.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import Iterable, Literal, Protocol

from ..analysis.load_runs import RunCatalog
from ..analysis.regression_detector import RegressionReport, detect_regressions
from ..run_record import RunRecord

__all__ = [
    "CohortRoutingResult",
    "DeterministicRouterSpec",
    "LearnedRouterSpec",
    "RouterExperiment",
    "RouterKind",
    "RouterSpec",
    "RoutingDecision",
    "build_router_experiment",
    "simulate_router_decisions",
]


RouterKind = Literal["deterministic", "learned"]


@dataclass(frozen=True)
class RoutingDecision:
    """A single routing decision for a task.

    ``chosen_model`` is the model id the router selected. ``reason`` is a
    stable enum string ("default", "escalation", "delegation", "cost_optimization").
    ``latency_ms`` is the router's own decision latency (not the model's).
    """

    task: str
    cohort: str
    chosen_model: str
    reason: str
    latency_ms: float
    confidence: float = 1.0
    metadata: dict[str, str] = field(default_factory=dict)


class RouterSpec(Protocol):
    """Interface for a router specification."""

    kind: RouterKind
    description: str

    def decide(self, task: str, cohort: str) -> RoutingDecision:
        """Make a routing decision for a single task."""
        ...


@dataclass(frozen=True)
class DeterministicRouterSpec:
    """The production deterministic router (SPEC §14.2).

    Routes by cohort → model mapping with explicit escalation rules.
    """

    kind: RouterKind = "deterministic"
    description: str = "Deterministic cohort-based router with escalation"
    cohort_model_map: dict[str, str] = field(
        default_factory=lambda: {
            "tiny_bugfix": "fast-model",
            "refactor": "balanced-model",
            "security_sensitive": "strong-model",
            "large_context_migration": "long-context-model",
        }
    )
    default_model: str = "balanced-model"
    escalation_model: str = "strong-model"
    escalation_risk_classes: tuple[str, ...] = ("elevated", "high", "critical")
    decision_latency_ms: float = 0.5

    def decide(self, task: str, cohort: str) -> RoutingDecision:
        """Make a deterministic routing decision."""
        return RoutingDecision(
            task=task,
            cohort=cohort,
            chosen_model=self.cohort_model_map.get(cohort, self.default_model),
            reason="default",
            latency_ms=self.decision_latency_ms,
        )


@dataclass(frozen=True)
class LearnedRouterSpec:
    """A learned router (research only — must clear the promotion gate).

    ``cohort_model_map`` is the learned policy. ``decision_latency_ms`` is
    the router's inference latency, which is *added* to every run and must
    be accounted for in the cost / latency Pareto check.
    """

    cohort_model_map: dict[str, str]
    kind: RouterKind = "learned"
    description: str = "Learned cohort→model router (research)"
    decision_latency_ms: float = 5.0
    confidence: float = 0.85

    def decide(self, task: str, cohort: str) -> RoutingDecision:
        """Make a learned routing decision."""
        return RoutingDecision(
            task=task,
            cohort=cohort,
            chosen_model=self.cohort_model_map.get(cohort, "balanced-model"),
            reason="learned",
            latency_ms=self.decision_latency_ms,
            confidence=self.confidence,
        )


@dataclass
class CohortRoutingResult:
    """Per-cohort routing results for one router spec."""

    router_kind: RouterKind
    cohort: str
    decisions: list[RoutingDecision] = field(default_factory=list)

    @property
    def n(self) -> int:
        """Number of decisions."""
        return len(self.decisions)

    @property
    def mean_latency_ms(self) -> float:
        """Mean decision latency."""
        if not self.decisions:
            return 0.0
        return sum(d.latency_ms for d in self.decisions) / len(self.decisions)

    @property
    def model_distribution(self) -> dict[str, int]:
        """Counts per chosen model."""
        out: dict[str, int] = {}
        for d in self.decisions:
            out[d.chosen_model] = out.get(d.chosen_model, 0) + 1
        return out


@dataclass
class RouterExperiment:
    """A model-routing experiment comparing two router specs."""

    baseline: RouterSpec
    candidate: RouterSpec
    baseline_results: list[CohortRoutingResult] = field(default_factory=list)
    candidate_results: list[CohortRoutingResult] = field(default_factory=list)

    def summary(self) -> dict[str, object]:
        """High-level summary of the routing experiment."""
        return {
            "baseline_kind": self.baseline.kind,
            "candidate_kind": self.candidate.kind,
            "baseline_n_decisions": sum(r.n for r in self.baseline_results),
            "candidate_n_decisions": sum(r.n for r in self.candidate_results),
            "baseline_mean_latency_ms": _mean_or_zero(
                [r.mean_latency_ms for r in self.baseline_results]
            ),
            "candidate_mean_latency_ms": _mean_or_zero(
                [r.mean_latency_ms for r in self.candidate_results]
            ),
            "baseline_model_distribution": _merge_distributions(
                [r.model_distribution for r in self.baseline_results]
            ),
            "candidate_model_distribution": _merge_distributions(
                [r.model_distribution for r in self.candidate_results]
            ),
        }


def _mean_or_zero(values: list[float]) -> float:
    """Mean of a list, returning 0.0 for empty input."""
    if not values:
        return 0.0
    return sum(values) / len(values)


def _merge_distributions(dists: list[dict[str, int]]) -> dict[str, int]:
    """Merge a list of model→count dicts into one."""
    out: dict[str, int] = {}
    for d in dists:
        for k, v in d.items():
            out[k] = out.get(k, 0) + v
    return out


def simulate_router_decisions(
    router: RouterSpec,
    tasks: Iterable[tuple[str, str]],
) -> list[RoutingDecision]:
    """Run a router over a list of (task, cohort) pairs.

    This is the *research* path: in production the router runs inside the
    control plane; here we simulate it offline to compare routing policies.
    """
    return [router.decide(task=t, cohort=c) for t, c in tasks]


def build_router_experiment(
    baseline: RouterSpec,
    candidate: RouterSpec,
    tasks_by_cohort: dict[str, list[str]],
) -> RouterExperiment:
    """Build a :class:`RouterExperiment` by simulating both routers."""
    exp = RouterExperiment(baseline=baseline, candidate=candidate)
    for cohort, tasks in tasks_by_cohort.items():
        b_decisions = [baseline.decide(task=t, cohort=cohort) for t in tasks]
        c_decisions = [candidate.decide(task=t, cohort=cohort) for t in tasks]
        exp.baseline_results.append(
            CohortRoutingResult(router_kind=baseline.kind, cohort=cohort, decisions=b_decisions)
        )
        exp.candidate_results.append(
            CohortRoutingResult(router_kind=candidate.kind, cohort=cohort, decisions=c_decisions)
        )
    return exp


def detect_routing_regressions(
    baseline_runs: Iterable[RunRecord] | RunCatalog,
    candidate_runs: Iterable[RunRecord] | RunCatalog,
    *,
    baseline_label: str = "deterministic",
    candidate_label: str = "learned",
    noninferiority_margin: float = 0.05,
) -> RegressionReport:
    """Detect regressions across cohorts when switching routers.

    Uses :func:`forge_evals.analysis.regression_detector.detect_regressions`
    on the run records produced under each router. The non-inferiority
    margin defaults to 5% — a learned router that is more than 5% worse on
    any critical cohort is not eligible for promotion.
    """
    return detect_regressions(
        baseline_runs,
        candidate_runs,
        baseline_label=baseline_label,
        candidate_label=candidate_label,
        noninferiority_margin=noninferiority_margin,
    )


def random_learned_policy(
    rng_seed: int = 0,
    models: tuple[str, ...] = ("fast-model", "balanced-model", "strong-model", "long-context-model"),
    cohorts: tuple[str, ...] = ("tiny_bugfix", "refactor", "security_sensitive", "large_context_migration"),
) -> dict[str, str]:
    """Generate a random learned router policy.

    Useful for sweep experiments: generate N random policies, evaluate each,
    and pick the best. Production routers should be trained, not random.
    """
    rng = random.Random(rng_seed)
    return {cohort: rng.choice(models) for cohort in cohorts}

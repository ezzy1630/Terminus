"""SPEC §41.8 / §41.9 / §41.10 / §14.2 research experiments.

Context ablations, ACI ablations, orchestration ablations, and routing
research. These are *research-grade* modules — they describe experiments
and provide scaffolding for running them. None of this code is on the
production critical path (SPEC §43.3).
"""

from __future__ import annotations

from .aci_ablations import (
    ACI_ABLATIONS,
    ACIAblation,
    ACIAblationCatalog,
    aci_ablation_by_id,
    build_aci_ablation_assignments,
)
from .context_ablations import (
    CONTEXT_ABLATIONS,
    ContextAblation,
    ContextAblationCatalog,
    build_context_ablation_assignments,
    context_ablation_by_id,
)
from .orchestration_ablations import (
    ORCHESTRATION_ABLATIONS,
    OrchestrationAblation,
    OrchestrationAblationCatalog,
    build_orchestration_ablation_assignments,
    orchestration_ablation_by_id,
)
from .routing_research import (
    CohortRoutingResult,
    DeterministicRouterSpec,
    LearnedRouterSpec,
    RouterExperiment,
    RouterSpec,
    RoutingDecision,
    build_router_experiment,
    detect_routing_regressions,
    random_learned_policy,
    simulate_router_decisions,
)

__all__ = [
    "ACI_ABLATIONS",
    "CONTEXT_ABLATIONS",
    "ORCHESTRATION_ABLATIONS",
    "ACIAblation",
    "ACIAblationCatalog",
    "CohortRoutingResult",
    "ContextAblation",
    "ContextAblationCatalog",
    "DeterministicRouterSpec",
    "LearnedRouterSpec",
    "OrchestrationAblation",
    "OrchestrationAblationCatalog",
    "RouterExperiment",
    "RouterSpec",
    "RoutingDecision",
    "aci_ablation_by_id",
    "build_aci_ablation_assignments",
    "build_context_ablation_assignments",
    "build_orchestration_ablation_assignments",
    "build_router_experiment",
    "context_ablation_by_id",
    "detect_routing_regressions",
    "orchestration_ablation_by_id",
    "random_learned_policy",
    "simulate_router_decisions",
]

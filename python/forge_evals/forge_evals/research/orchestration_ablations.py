"""SPEC §41.10 orchestration-ablation experiments.

Each ablation toggles a single orchestration dimension (scout, parallel
writers, reviewer triggers, escalation thresholds, loop policies) and
measures the effect on success rate, latency, and cost.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

__all__ = [
    "OrchestrationAblation",
    "OrchestrationAblationCatalog",
    "OrchestrationAblationDimension",
    "ORCHESTRATION_ABLATIONS",
    "build_orchestration_ablation_assignments",
    "orchestration_ablation_by_id",
]


@dataclass(frozen=True)
class OrchestrationAblation:
    """A single orchestration ablation (SPEC §41.10)."""

    ablation_id: str
    dimension: str
    description: str
    spec_ref: str
    baseline_setting: str
    candidate_setting: str
    # Which cohort the ablation is most interesting on (per SPEC §41.10 /
    # §41.3 — parallelizable-task vs task-where-multi-agent-should-lose).
    target_cohort: str = ""
    predicted_direction: int = 0
    metadata: dict[str, str] = field(default_factory=dict)


ORCHESTRATION_ABLATIONS: list[OrchestrationAblation] = [
    OrchestrationAblation(
        ablation_id="orch_one_vs_scout",
        dimension="scout",
        description="One agent vs read-only scout",
        spec_ref="§41.10",
        baseline_setting="one_agent",
        candidate_setting="scout+worker",
        target_cohort="unfamiliar_repository",
        predicted_direction=1,
    ),
    OrchestrationAblation(
        ablation_id="orch_one_vs_parallel_writers",
        dimension="parallel_writers",
        description="One agent vs parallel writers on separable tasks",
        spec_ref="§41.10",
        baseline_setting="one_agent",
        candidate_setting="parallel_writers",
        target_cohort="parallelizable_task",
        predicted_direction=1,
    ),
    OrchestrationAblation(
        ablation_id="orch_parallel_on_tight_coupling",
        dimension="parallel_writers",
        description="Parallel writers on a tightly-coupled task (should NOT help)",
        spec_ref="§41.10",
        baseline_setting="one_agent",
        candidate_setting="parallel_writers",
        target_cohort="task_where_multi_agent_should_lose",
        predicted_direction=-1,
    ),
    OrchestrationAblation(
        ablation_id="orch_deterministic_reviewer_triggers",
        dimension="reviewer_trigger",
        description="Deterministic reviewer triggers on/off",
        spec_ref="§41.10",
        baseline_setting="off",
        candidate_setting="on",
        target_cohort="security_sensitive",
        predicted_direction=1,
    ),
    OrchestrationAblation(
        ablation_id="orch_different_family_reviewer",
        dimension="reviewer_family",
        description="Same-family reviewer vs different-family reviewer",
        spec_ref="§41.10",
        baseline_setting="same_family",
        candidate_setting="different_family",
        target_cohort="refactor",
        predicted_direction=1,
    ),
    OrchestrationAblation(
        ablation_id="orch_worker_contract_context_size",
        dimension="worker_context",
        description="Worker contract context size (minimal / standard / verbose)",
        spec_ref="§41.10",
        baseline_setting="minimal",
        candidate_setting="standard",
        target_cohort="parallelizable_task",
        predicted_direction=1,
    ),
    OrchestrationAblation(
        ablation_id="orch_worktree_strategy",
        dimension="worktree",
        description="Worktree integration strategy (shared / per-worker / git-branch)",
        spec_ref="§41.10",
        baseline_setting="shared",
        candidate_setting="per_worker",
        target_cohort="parallelizable_task",
        predicted_direction=1,
    ),
    OrchestrationAblation(
        ablation_id="orch_escalation_thresholds",
        dimension="escalation",
        description="Escalation thresholds (low / medium / high)",
        spec_ref="§41.10",
        baseline_setting="medium",
        candidate_setting="low",
        target_cohort="security_sensitive",
        predicted_direction=0,
    ),
    OrchestrationAblation(
        ablation_id="orch_loop_intervention_policies",
        dimension="loop_policy",
        description="Loop-intervention policies (off / detect / detect+interrupt)",
        spec_ref="§41.10",
        baseline_setting="detect",
        candidate_setting="detect+interrupt",
        target_cohort="compaction_mid_implementation",
        predicted_direction=1,
    ),
]


@dataclass
class OrchestrationAblationCatalog:
    """Catalog of all orchestration ablations."""

    ablations: list[OrchestrationAblation] = field(
        default_factory=lambda: list(ORCHESTRATION_ABLATIONS)
    )

    def by_id(self, ablation_id: str) -> OrchestrationAblation:
        """Look up by id."""
        for a in self.ablations:
            if a.ablation_id == ablation_id:
                return a
        raise KeyError(f"unknown orchestration ablation id: {ablation_id!r}")

    def by_dimension(self, dimension: str) -> list[OrchestrationAblation]:
        """All ablations on the given dimension."""
        return [a for a in self.ablations if a.dimension == dimension]


def orchestration_ablation_by_id(ablation_id: str) -> OrchestrationAblation:
    """Look up by id."""
    return OrchestrationAblationCatalog().by_id(ablation_id)


def build_orchestration_ablation_assignments(
    ablation_ids: list[str] | None = None,
) -> list[dict[str, str]]:
    """Build experiment_assignments for an orchestration ablation experiment."""
    catalog = OrchestrationAblationCatalog()
    ids = ablation_ids or [a.ablation_id for a in catalog.ablations]
    out: list[dict[str, str]] = []
    for aid in ids:
        a = catalog.by_id(aid)
        out.append(
            {
                "ablation_id": a.ablation_id,
                "dimension": a.dimension,
                "baseline_setting": a.baseline_setting,
                "candidate_setting": a.candidate_setting,
                "target_cohort": a.target_cohort,
            }
        )
    return out


OrchestrationAblationDimension = Literal[
    "scout",
    "parallel_writers",
    "reviewer_trigger",
    "reviewer_family",
    "worker_context",
    "worktree",
    "escalation",
    "loop_policy",
]

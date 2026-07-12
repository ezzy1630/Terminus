"""SPEC §41.9 ACI-ablation experiments.

Each ablation toggles a single Agent-Computer Interface dimension and
measures the effect on tool-selection accuracy, argument-error rate, and
end-state success.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

__all__ = [
    "ACIAblation",
    "ACIAblationCatalog",
    "ACIAblationDimension",
    "ACI_ABLATIONS",
    "aci_ablation_by_id",
    "build_aci_ablation_assignments",
]


@dataclass(frozen=True)
class ACIAblation:
    """A single ACI ablation (SPEC §41.9)."""

    ablation_id: str
    dimension: str
    description: str
    spec_ref: str
    baseline_setting: str
    candidate_setting: str
    predicted_direction: int = 0
    metadata: dict[str, str] = field(default_factory=dict)


ACI_ABLATIONS: list[ACIAblation] = [
    ACIAblation(
        ablation_id="aci_structured_argv_vs_shell",
        dimension="argv_form",
        description="Structured argv vs shell string for tool invocation",
        spec_ref="§41.9",
        baseline_setting="shell_string",
        candidate_setting="structured_argv",
        predicted_direction=1,
    ),
    ACIAblation(
        ablation_id="aci_edit_dialects_by_model",
        dimension="edit_dialect",
        description="Symbol/range/text/unified-diff edit dialects by model",
        spec_ref="§41.9",
        baseline_setting="text",
        candidate_setting="symbol+range+unified_diff",
        predicted_direction=1,
    ),
    ACIAblation(
        ablation_id="aci_immediate_diagnostics_on_off",
        dimension="immediate_diagnostics",
        description="Immediate diagnostics on vs off after each edit",
        spec_ref="§41.9",
        baseline_setting="off",
        candidate_setting="on",
        predicted_direction=1,
    ),
    ACIAblation(
        ablation_id="aci_read_outline_sizes",
        dimension="read_outline",
        description="Read outline sizes (none / 100 / 500 / 2000 lines)",
        spec_ref="§41.9",
        baseline_setting="none",
        candidate_setting="500",
        predicted_direction=1,
    ),
    ACIAblation(
        ablation_id="aci_search_ranking",
        dimension="search_ranking",
        description="Search result count and ranking variants",
        spec_ref="§41.9",
        baseline_setting="lexical_top_10",
        candidate_setting="fusion_top_20",
        predicted_direction=1,
    ),
    ACIAblation(
        ablation_id="aci_tool_description_variants",
        dimension="tool_description",
        description="Tool description variants (terse / standard / verbose / example-rich)",
        spec_ref="§41.9",
        baseline_setting="standard",
        candidate_setting="example_rich",
        predicted_direction=1,
    ),
    ACIAblation(
        ablation_id="aci_ask_vs_structured_decision",
        dimension="decision_protocol",
        description="Ask tool vs structured decision outcome for ambiguity resolution",
        spec_ref="§41.9",
        baseline_setting="ask",
        candidate_setting="structured_decision",
        predicted_direction=0,
    ),
    ACIAblation(
        ablation_id="aci_capability_activation_granularity",
        dimension="capability_activation",
        description="Capability activation granularity (per-task / per-turn / per-tool)",
        spec_ref="§41.9",
        baseline_setting="per_task",
        candidate_setting="per_turn",
        predicted_direction=1,
    ),
    ACIAblation(
        ablation_id="aci_programmatic_tool_composition",
        dimension="tool_composition",
        description="Programmatic tool-composition mode on vs off",
        spec_ref="§41.9",
        baseline_setting="off",
        candidate_setting="on",
        predicted_direction=0,
        metadata={"gate": "Programmatic composition requires capability-token chain validation."},
    ),
]


@dataclass
class ACIAblationCatalog:
    """Catalog of all ACI ablations."""

    ablations: list[ACIAblation] = field(default_factory=lambda: list(ACI_ABLATIONS))

    def by_id(self, ablation_id: str) -> ACIAblation:
        """Look up by id."""
        for a in self.ablations:
            if a.ablation_id == ablation_id:
                return a
        raise KeyError(f"unknown ACI ablation id: {ablation_id!r}")

    def by_dimension(self, dimension: str) -> list[ACIAblation]:
        """All ablations on the given dimension."""
        return [a for a in self.ablations if a.dimension == dimension]


def aci_ablation_by_id(ablation_id: str) -> ACIAblation:
    """Look up by id."""
    return ACIAblationCatalog().by_id(ablation_id)


def build_aci_ablation_assignments(
    ablation_ids: list[str] | None = None,
) -> list[dict[str, str]]:
    """Build experiment_assignments for an ACI ablation experiment."""
    catalog = ACIAblationCatalog()
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
            }
        )
    return out


ACIAblationDimension = Literal[
    "argv_form",
    "edit_dialect",
    "immediate_diagnostics",
    "read_outline",
    "search_ranking",
    "tool_description",
    "decision_protocol",
    "capability_activation",
    "tool_composition",
]

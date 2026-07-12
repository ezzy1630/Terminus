"""SPEC §41.8 context-ablation experiments.

Each ablation toggles a single context-compiler dimension and measures the
effect on the primary metric. SPEC §41.8 lists the required initial
experiments; this module codifies them as dataclasses so that an experiment
manifest can reference them by id.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

__all__ = [
    "ContextAblation",
    "ContextAblationCatalog",
    "CONTEXT_ABLATIONS",
    "context_ablation_by_id",
]


@dataclass(frozen=True)
class ContextAblation:
    """A single context-compiler ablation (SPEC §41.8)."""

    ablation_id: str
    dimension: str
    description: str
    spec_ref: str
    baseline_setting: str
    candidate_setting: str
    # Whether the ablation is expected to help (1), hurt (-1), or be neutral (0).
    predicted_direction: int = 0
    metadata: dict[str, str] = field(default_factory=dict)


# ──────────────────────────── catalog ─────────────────────────────────────
# Order follows SPEC §41.8.

CONTEXT_ABLATIONS: list[ContextAblation] = [
    ContextAblation(
        ablation_id="ctx_full_vs_recent_episodes",
        dimension="history_mode",
        description="Full conversation history vs recent complete episodes plus checkpoint",
        spec_ref="§41.8",
        baseline_setting="full_history",
        candidate_setting="recent_episodes+checkpoint",
        predicted_direction=0,
    ),
    ContextAblation(
        ablation_id="ctx_fixed_vs_adaptive_window",
        dimension="window_mode",
        description="Fixed recent window vs adaptive recent window",
        spec_ref="§41.8",
        baseline_setting="fixed_window",
        candidate_setting="adaptive_window",
        predicted_direction=1,
    ),
    ContextAblation(
        ablation_id="ctx_flat_summary_vs_provenance_dag",
        dimension="summary_mode",
        description="Flat summary vs provenance DAG",
        spec_ref="§41.8",
        baseline_setting="flat_summary",
        candidate_setting="provenance_dag",
        predicted_direction=1,
    ),
    ContextAblation(
        ablation_id="ctx_snapshot_vs_deltas",
        dimension="world_state_mode",
        description="World-state snapshot vs deltas",
        spec_ref="§41.8",
        baseline_setting="snapshot",
        candidate_setting="deltas",
        predicted_direction=0,
    ),
    ContextAblation(
        ablation_id="ctx_lexical_vs_ast_lsp",
        dimension="retrieval_mode",
        description="Lexical retrieval vs lexical+AST+LSP retrieval",
        spec_ref="§41.8",
        baseline_setting="lexical",
        candidate_setting="lexical+AST+LSP",
        predicted_direction=1,
    ),
    ContextAblation(
        ablation_id="ctx_repo_map_variants",
        dimension="repo_map",
        description="Repository map variants (off / minimal / full / layered)",
        spec_ref="§41.8",
        baseline_setting="minimal",
        candidate_setting="layered",
        predicted_direction=1,
    ),
    ContextAblation(
        ablation_id="ctx_evidence_coverage_on_off",
        dimension="evidence_coverage",
        description="Evidence-coverage pass on vs off",
        spec_ref="§41.8",
        baseline_setting="off",
        candidate_setting="on",
        predicted_direction=1,
    ),
    ContextAblation(
        ablation_id="ctx_memory_on_off",
        dimension="memory",
        description="Memory subsystem on vs off",
        spec_ref="§41.8",
        baseline_setting="off",
        candidate_setting="on",
        predicted_direction=1,
    ),
    ContextAblation(
        ablation_id="ctx_tool_palette_size",
        dimension="tool_palette",
        description="Tool palette size (minimal vs progressive vs full)",
        spec_ref="§41.8",
        baseline_setting="minimal",
        candidate_setting="progressive",
        predicted_direction=1,
    ),
    ContextAblation(
        ablation_id="ctx_provider_specific_ordering",
        dimension="provider_ordering",
        description="Provider-specific fragment ordering vs canonical ordering",
        spec_ref="§41.8",
        baseline_setting="canonical",
        candidate_setting="provider_specific",
        predicted_direction=1,
    ),
    ContextAblation(
        ablation_id="ctx_native_vs_local_compaction",
        dimension="compaction_mode",
        description="Native provider compaction vs local compaction",
        spec_ref="§41.8",
        baseline_setting="native",
        candidate_setting="local",
        predicted_direction=0,
    ),
    ContextAblation(
        ablation_id="ctx_deterministic_vs_learned_compression",
        dimension="compression_mode",
        description="Deterministic compression vs external learned compression",
        spec_ref="§41.8",
        baseline_setting="deterministic",
        candidate_setting="learned",
        predicted_direction=0,
        metadata={"gate": "External compression is disabled unless its gate passes (SPEC §50.7)."},
    ),
]


@dataclass
class ContextAblationCatalog:
    """Catalog of all context ablations."""

    ablations: list[ContextAblation] = field(default_factory=lambda: list(CONTEXT_ABLATIONS))

    def by_id(self, ablation_id: str) -> ContextAblation:
        """Look up an ablation by id."""
        for a in self.ablations:
            if a.ablation_id == ablation_id:
                return a
        raise KeyError(f"unknown context ablation id: {ablation_id!r}")

    def by_dimension(self, dimension: str) -> list[ContextAblation]:
        """Return all ablations on the given dimension."""
        return [a for a in self.ablations if a.dimension == dimension]


def context_ablation_by_id(ablation_id: str) -> ContextAblation:
    """Look up a context ablation by id."""
    return ContextAblationCatalog().by_id(ablation_id)


# ──────────────────────────── experiment helpers ─────────────────────────


def build_context_ablation_assignments(
    ablation_ids: list[str] | None = None,
) -> list[dict[str, str]]:
    """Build the experiment_assignments list for a context-ablation experiment.

    Each ablation id maps to a dict with ``dimension``, ``baseline_setting``,
    ``candidate_setting`` — the runner writes these into the run record.
    """
    catalog = ContextAblationCatalog()
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


ContextAblationDimension = Literal[
    "history_mode",
    "window_mode",
    "summary_mode",
    "world_state_mode",
    "retrieval_mode",
    "repo_map",
    "evidence_coverage",
    "memory",
    "tool_palette",
    "provider_ordering",
    "compaction_mode",
    "compression_mode",
]

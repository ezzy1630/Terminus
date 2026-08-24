"""SPEC §46.11 evaluation tiers.

Defines the evaluation tiers and task selection rules for PRs, nightly builds,
releases, and research experiments.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Any

__all__ = ["EvalTier", "TierConfig", "get_tier_config", "list_all_tiers"]


class EvalTier(StrEnum):
    """Evaluation tiers (SPEC §46.11)."""

    SMOKE = "smoke"
    TARGETED = "targeted"
    NIGHTLY = "nightly"
    RELEASE = "release"
    RESEARCH = "research"


@dataclass(frozen=True)
class TierConfig:
    """Configuration for an evaluation tier."""

    tier: EvalTier
    description: str
    is_gating: bool
    seeds_per_task: int
    max_tasks_per_cohort: int | None
    budget_multiplier: float
    required_cohorts: tuple[str, ...]
    baseline_harnesses: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "tier": self.tier.value,
            "description": self.description,
            "is_gating": self.is_gating,
            "seeds_per_task": self.seeds_per_task,
            "max_tasks_per_cohort": self.max_tasks_per_cohort,
            "budget_multiplier": self.budget_multiplier,
            "required_cohorts": list(self.required_cohorts),
            "baseline_harnesses": list(self.baseline_harnesses),
        }


_TIER_CONFIGS: dict[EvalTier, TierConfig] = {
    EvalTier.SMOKE: TierConfig(
        tier=EvalTier.SMOKE,
        description="Fast deterministic subset required for PRs changing agent behavior",
        is_gating=True,
        seeds_per_task=1,
        max_tasks_per_cohort=1,
        budget_multiplier=0.5,
        required_cohorts=("tiny-bugfix", "build-failure"),
        baseline_harnesses=("forge_minimal", "forge_full"),
    ),
    EvalTier.TARGETED: TierConfig(
        tier=EvalTier.TARGETED,
        description="Cohort-specific suite associated with changed component",
        is_gating=True,
        seeds_per_task=3,
        max_tasks_per_cohort=5,
        budget_multiplier=1.0,
        required_cohorts=("tiny-bugfix", "refactor", "security-sensitive"),
        baseline_harnesses=("forge_minimal", "forge_full"),
    ),
    EvalTier.NIGHTLY: TierConfig(
        tier=EvalTier.NIGHTLY,
        description="Broad pinned suite with repeated seeds across all core cohorts",
        is_gating=True,
        seeds_per_task=5,
        max_tasks_per_cohort=10,
        budget_multiplier=1.0,
        required_cohorts=(
            "tiny-bugfix",
            "small-feature",
            "refactor",
            "security-sensitive",
            "long-horizon",
            "multi-file",
            "test-debug",
            "build-fix",
        ),
        baseline_harnesses=("forge_minimal", "forge_full", "codex", "pi"),
    ),
    EvalTier.RELEASE: TierConfig(
        tier=EvalTier.RELEASE,
        description="Full promotion gate suite across all 19 cohorts and all baseline harnesses",
        is_gating=True,
        seeds_per_task=10,
        max_tasks_per_cohort=None,
        budget_multiplier=1.5,
        required_cohorts=(
            "tiny-bugfix",
            "small-feature",
            "refactor",
            "security-sensitive",
            "long-horizon",
            "multi-file",
            "test-debug",
            "build-fix",
            "dependency-upgrade",
            "docs-update",
            "performance-fix",
            "api-design",
            "database-migration",
            "frontend-change",
            "config-change",
            "ci-fix",
            "release-prep",
            "code-review",
            "research-task",
        ),
        baseline_harnesses=(
            "forge_minimal",
            "forge_full",
            "upstream_opencode",
            "codex",
            "claude_code",
            "pi",
            "oh_my_pi",
            "mini_swe_agent",
        ),
    ),
    EvalTier.RESEARCH: TierConfig(
        tier=EvalTier.RESEARCH,
        description="Exploratory, non-gating suite for component ablations and experimental features",
        is_gating=False,
        seeds_per_task=3,
        max_tasks_per_cohort=None,
        budget_multiplier=2.0,
        required_cohorts=(),
        baseline_harnesses=("forge_minimal", "forge_full"),
    ),
}


def get_tier_config(tier: str | EvalTier) -> TierConfig:
    """Return the configuration for ``tier`` or raise ``KeyError``."""
    key = EvalTier(tier)
    return _TIER_CONFIGS[key]


def list_all_tiers() -> list[TierConfig]:
    """Return all tier configurations."""
    return list(_TIER_CONFIGS.values())

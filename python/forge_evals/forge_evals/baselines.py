"""SPEC §18.1 / §41.2 permanent baselines.

Each baseline is a pinned, versioned harness that runs against the same
cohorts as the candidate Terminus builds. Baselines are *refreshed deliberately*
— old results retain exact version metadata (SPEC §41.2).

Two comparison modes (SPEC §18.1):

1. ``model_fixed`` — same model/version/environment/budget across harnesses.
2. ``native_best`` — each harness's recommended stack, reported separately.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

__all__ = ["BASELINES", "Baseline", "ComparisonMode", "baseline_by_id"]

ComparisonMode = Literal["model_fixed", "native_best"]


@dataclass(frozen=True)
class Baseline:
    """A permanent evaluation baseline harness.

    Pin information (``pin``, ``pin_kind``) is recorded so that old run
    records remain interpretable after the baseline is refreshed.
    """

    id: str
    name: str
    description: str
    pin: str  # git commit, image digest, or release tag
    pin_kind: Literal["git_commit", "image_digest", "release_tag"]
    supports_model_fixed: bool = True
    supports_native_best: bool = True
    licensing_permits_automation: bool = True
    notes: str = ""
    metadata: dict[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.id:
            raise ValueError("baseline id is required")
        if self.pin_kind not in ("git_commit", "image_digest", "release_tag"):
            raise ValueError(f"unknown pin_kind: {self.pin_kind}")


# ──────────────────────────── baseline catalog ────────────────────────────
# SPEC §18.1 lists: upstream OpenCode; Codex; Claude Code (where licensing
# permits); Pi; Oh My Pi; mini-SWE-agent; Terminus minimal; Terminus full.
# SPEC §41.2 adds the same set with the explicit "pinned runners" requirement.

BASELINES: list[Baseline] = [
    Baseline(
        id="forge_minimal",
        name="Terminus minimal",
        description=(
            "Terminus in minimal shell-only mode (SPEC §3.7): Bash, Read, Edit, List, "
            "Search. No MCP, no plugins, no parallel agents. Permanent floor — "
            "the minimal mode remains permanently available (SPEC §18.7)."
        ),
        pin="git:terminus@v0.1.0",
        pin_kind="git_commit",
        supports_model_fixed=True,
        supports_native_best=True,
    ),
    Baseline(
        id="forge_full",
        name="Terminus full",
        description=(
            "Terminus with all components enabled: context compiler, orchestration, "
            "verification, memory, capability registry."
        ),
        pin="git:terminus@v0.1.0",
        pin_kind="git_commit",
        supports_model_fixed=True,
        supports_native_best=True,
    ),
    Baseline(
        id="upstream_opencode",
        name="Upstream OpenCode (pinned)",
        description=(
            "Inherited OpenCode at a pinned commit. Used for parity / divergence "
            "tracking (SPEC §6.1, §6.2)."
        ),
        pin="git:opencode@pinned",
        pin_kind="git_commit",
        supports_model_fixed=True,
        supports_native_best=True,
    ),
    Baseline(
        id="codex",
        name="Codex",
        description="Current Codex CLI at a pinned release tag.",
        pin="release:codex@pinned",
        pin_kind="release_tag",
        supports_model_fixed=True,
        supports_native_best=True,
    ),
    Baseline(
        id="claude_code",
        name="Claude Code",
        description=(
            "Claude Code CLI. Automation permitted only where licensing allows; "
            "the ``licensing_permits_automation`` flag is the single source of truth."
        ),
        pin="release:claude-code@pinned",
        pin_kind="release_tag",
        supports_model_fixed=True,
        supports_native_best=True,
        licensing_permits_automation=False,
    ),
    Baseline(
        id="pi",
        name="Pi",
        description="Pi coding agent at a pinned release tag.",
        pin="release:pi@pinned",
        pin_kind="release_tag",
        supports_model_fixed=True,
        supports_native_best=True,
    ),
    Baseline(
        id="oh_my_pi",
        name="Oh My Pi",
        description="Oh My Pi agent at a pinned release tag.",
        pin="release:oh-my-pi@pinned",
        pin_kind="release_tag",
        supports_model_fixed=True,
        supports_native_best=True,
    ),
    Baseline(
        id="mini_swe_agent",
        name="mini-SWE-agent",
        description=(
            "Minimal terminal agent (SWE-bench-style). Used as a low-overhead "
            "comparison point per SPEC §41.2."
        ),
        pin="release:mini-swe-agent@pinned",
        pin_kind="release_tag",
        supports_model_fixed=True,
        supports_native_best=True,
    ),
]

_BASELINE_INDEX: dict[str, Baseline] = {b.id: b for b in BASELINES}


def baseline_by_id(baseline_id: str) -> Baseline:
    """Return the baseline with ``baseline_id`` or raise ``KeyError``."""
    if baseline_id not in _BASELINE_INDEX:
        raise KeyError(f"unknown baseline id: {baseline_id!r}")
    return _BASELINE_INDEX[baseline_id]


def all_baseline_ids() -> list[str]:
    """Return the list of all baseline ids in catalog order."""
    return [b.id for b in BASELINES]

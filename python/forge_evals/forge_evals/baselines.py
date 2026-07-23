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
from typing import Any, Literal

__all__ = [
    "BASELINES",
    "Baseline",
    "ComparisonMode",
    "HarnessCapabilities",
    "all_baseline_ids",
    "baseline_by_id",
    "validate_harness_task_compatibility",
]

ComparisonMode = Literal["model_fixed", "native_best"]


@dataclass(frozen=True)
class HarnessCapabilities:
    """Explicit capability matrix for a baseline harness (SPEC §41.1).
    
    Prevents pretending all harnesses support identical tasks or features.
    """

    supports_mcp: bool = False
    supports_subagents: bool = False
    supports_hidden_tests: bool = True
    supports_context_compilation: bool = False
    supports_verification_loop: bool = False
    supported_tools: tuple[str, ...] = ("bash", "read", "edit")
    supported_dialects: tuple[str, ...] = ("exact_text",)
    supported_cohorts: tuple[str, ...] = ()
    requires_network: bool = False
    max_turns_supported: int = 50

    def to_dict(self) -> dict[str, Any]:
        return {
            "supports_mcp": self.supports_mcp,
            "supports_subagents": self.supports_subagents,
            "supports_hidden_tests": self.supports_hidden_tests,
            "supports_context_compilation": self.supports_context_compilation,
            "supports_verification_loop": self.supports_verification_loop,
            "supported_tools": list(self.supported_tools),
            "supported_dialects": list(self.supported_dialects),
            "supported_cohorts": list(self.supported_cohorts),
            "requires_network": self.requires_network,
            "max_turns_supported": self.max_turns_supported,
        }


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
    capabilities: HarnessCapabilities = field(default_factory=HarnessCapabilities)
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
        capabilities=HarnessCapabilities(
            supports_mcp=False,
            supports_subagents=False,
            supports_hidden_tests=True,
            supports_context_compilation=False,
            supports_verification_loop=False,
            supported_tools=("bash", "read_file", "replace_file_content", "list_dir", "grep_search"),
            supported_dialects=("exact_text",),
            max_turns_supported=30,
        ),
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
        capabilities=HarnessCapabilities(
            supports_mcp=True,
            supports_subagents=True,
            supports_hidden_tests=True,
            supports_context_compilation=True,
            supports_verification_loop=True,
            supported_tools=(
                "bash",
                "read_file",
                "replace_file_content",
                "list_dir",
                "grep_search",
                "invoke_subagent",
                "verification",
            ),
            supported_dialects=("exact_text", "unified_diff", "range"),
            max_turns_supported=100,
        ),
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
        capabilities=HarnessCapabilities(
            supports_mcp=True,
            supports_subagents=False,
            supports_hidden_tests=True,
            supports_context_compilation=False,
            supports_verification_loop=False,
            supported_tools=("bash", "read", "write", "edit"),
            supported_dialects=("exact_text",),
            max_turns_supported=50,
        ),
        supports_model_fixed=True,
        supports_native_best=True,
    ),
    Baseline(
        id="codex",
        name="Codex",
        description="Current Codex CLI at a pinned release tag.",
        pin="release:codex@pinned",
        pin_kind="release_tag",
        capabilities=HarnessCapabilities(
            supports_mcp=False,
            supports_subagents=False,
            supports_hidden_tests=True,
            supports_context_compilation=False,
            supports_verification_loop=False,
            supported_tools=("exec", "read", "patch"),
            supported_dialects=("unified_diff",),
            max_turns_supported=50,
        ),
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
        capabilities=HarnessCapabilities(
            supports_mcp=True,
            supports_subagents=False,
            supports_hidden_tests=True,
            supports_context_compilation=False,
            supports_verification_loop=False,
            supported_tools=("Bash", "FileRead", "FileEdit", "GlobTool", "GrepTool"),
            supported_dialects=("exact_text",),
            max_turns_supported=50,
        ),
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
        capabilities=HarnessCapabilities(
            supports_mcp=False,
            supports_subagents=False,
            supports_hidden_tests=True,
            supports_context_compilation=False,
            supports_verification_loop=False,
            supported_tools=("bash", "read", "write"),
            supported_dialects=("exact_text",),
            max_turns_supported=40,
        ),
        supports_model_fixed=True,
        supports_native_best=True,
    ),
    Baseline(
        id="oh_my_pi",
        name="Oh My Pi",
        description="Oh My Pi agent at a pinned release tag.",
        pin="release:oh-my-pi@pinned",
        pin_kind="release_tag",
        capabilities=HarnessCapabilities(
            supports_mcp=False,
            supports_subagents=False,
            supports_hidden_tests=True,
            supports_context_compilation=False,
            supports_verification_loop=False,
            supported_tools=("bash", "read", "write", "edit"),
            supported_dialects=("exact_text",),
            max_turns_supported=40,
        ),
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
        capabilities=HarnessCapabilities(
            supports_mcp=False,
            supports_subagents=False,
            supports_hidden_tests=True,
            supports_context_compilation=False,
            supports_verification_loop=False,
            supported_tools=("bash",),
            supported_dialects=("exact_text",),
            max_turns_supported=30,
        ),
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


def validate_harness_task_compatibility(
    baseline_id: str,
    task_requirements: dict[str, Any],
) -> tuple[bool, str]:
    """Check whether baseline ``baseline_id`` can execute task with ``task_requirements``.

    Returns ``(compatible: bool, reason: str)``. Explicitly surfaces capability
    differences instead of pretending all harnesses support identical tasks.
    """
    try:
        baseline = baseline_by_id(baseline_id)
    except KeyError:
        return False, f"Unknown baseline id: {baseline_id}"

    caps = baseline.capabilities
    req_mcp = task_requirements.get("requires_mcp", False)
    if req_mcp and not caps.supports_mcp:
        return False, f"Baseline {baseline_id} does not support MCP capabilities"

    req_subagents = task_requirements.get("requires_subagents", False)
    if req_subagents and not caps.supports_subagents:
        return False, f"Baseline {baseline_id} does not support multi-agent orchestration"

    req_turns = task_requirements.get("required_turns", 1)
    if req_turns > caps.max_turns_supported:
        return False, f"Task requires {req_turns} turns, but {baseline_id} max is {caps.max_turns_supported}"

    req_tools = task_requirements.get("required_tools", [])
    for tool in req_tools:
        if tool not in caps.supported_tools:
            return False, f"Baseline {baseline_id} lacks required tool: {tool}"

    return True, "Compatible"


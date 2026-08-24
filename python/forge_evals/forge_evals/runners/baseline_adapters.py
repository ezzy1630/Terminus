"""Runnable baseline harness adapters (SPEC §18.1, §41.2).

Provides deterministic :class:`Harness` fixtures for unit-testing the runner.
They are not live competitor adapters and cannot support release claims.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..run_record import CostBreakdown, Outcome
from .harness_runner import (
    Budgets,
    Harness,
    HarnessResult,
    RunRequest,
)
from .mini_swe_adapter import MiniSweAgentAdapter
from .trajectory_recorder import TrajectoryRecorder

__all__ = [
    "ClaudeCodeAdapter",
    "CodexAdapter",
    "ExternalHarnessUnavailable",
    "OhMyPiAdapter",
    "PiAdapter",
    "TerminusFullAdapter",
    "TerminusMinimalAdapter",
    "get_baseline_harness",
]


class ExternalHarnessUnavailable(RuntimeError):
    """Raised when a catalogued competitor has no configured external runner."""


@dataclass
class TerminusMinimalAdapter:
    """Terminus in minimal 5-tool shell mode (SPEC §3.7)."""

    final_revision: str = "git:terminus@v0.1.0-minimal"
    cost: CostBreakdown | None = None
    outcome: Outcome = Outcome.COMPLETED
    notes: str = "fixture-only Terminus minimal shape; not a live harness run"

    def run(self, request: RunRequest, recorder: TrajectoryRecorder) -> HarnessResult:
        recorder.record("task.activated", {"task": request.task, "harness": "forge_minimal"})
        recorder.record("turn.started", {"turn": 1})
        recorder.record_tool_proposed(
            tool_call_id="tool-min-1",
            tool_name="read_file",
            arguments={"path": "README.md"},
        )
        recorder.record_tool_settled(
            tool_call_id="tool-min-1", success=True, result_artifact_hash=None
        )
        recorder.record_tool_proposed(
            tool_call_id="tool-min-2",
            tool_name="replace_file_content",
            arguments={"path": "main.py"},
        )
        recorder.record_tool_settled(
            tool_call_id="tool-min-2", success=True, result_artifact_hash=None
        )
        recorder.record("turn.completed", {"turn": 1})

        cost = self.cost or _default_adapter_cost(request.budgets, multiplier=1.0)
        return HarnessResult(
            outcome=self.outcome,
            final_revision=self.final_revision,
            cost=cost,
            artifacts=[{"path": "patch.diff", "type": "unified_diff"}],
            context_manifests=[{"manifest_id": "m-min-1", "mode": "minimal"}],
            grader_outcomes=[],
            notes=self.notes,
        )


@dataclass
class TerminusFullAdapter:
    """Terminus in full production mode with context compiler, verification, and subagents."""

    final_revision: str = "git:terminus@v0.1.0-full"
    cost: CostBreakdown | None = None
    outcome: Outcome = Outcome.COMPLETED
    notes: str = "fixture-only Terminus full shape; not a live harness run"

    def run(self, request: RunRequest, recorder: TrajectoryRecorder) -> HarnessResult:
        recorder.record("task.activated", {"task": request.task, "harness": "forge_full"})
        recorder.record("turn.started", {"turn": 1})
        recorder.record(
            "context.manifest_persisted",
            {
                "manifest_id": "m-full-1",
                "token_budget": request.budgets.max_input_tokens,
                "fragment_count": 8,
            },
        )
        recorder.record_tool_proposed(
            tool_call_id="tool-full-1",
            tool_name="invoke_subagent",
            arguments={"role": "researcher"},
        )
        recorder.record_tool_settled(
            tool_call_id="tool-full-1", success=True, result_artifact_hash=None
        )
        recorder.record_tool_proposed(
            tool_call_id="tool-full-2",
            tool_name="verification",
            arguments={"command": "just check"},
        )
        recorder.record_tool_settled(
            tool_call_id="tool-full-2", success=True, result_artifact_hash=None
        )
        recorder.record("turn.completed", {"turn": 1})

        cost = self.cost or _default_adapter_cost(request.budgets, multiplier=1.2)
        return HarnessResult(
            outcome=self.outcome,
            final_revision=self.final_revision,
            cost=cost,
            artifacts=[{"path": "verification_evidence.json", "type": "evidence"}],
            context_manifests=[{"manifest_id": "m-full-1", "mode": "full"}],
            grader_outcomes=[],
            notes=self.notes,
        )


@dataclass
class CodexAdapter:
    """Codex CLI baseline harness."""

    final_revision: str = "release:codex@pinned"
    cost: CostBreakdown | None = None
    outcome: Outcome = Outcome.COMPLETED
    notes: str = "fixture-only Codex-shaped trace; not a live Codex run"

    def run(self, request: RunRequest, recorder: TrajectoryRecorder) -> HarnessResult:
        recorder.record("task.activated", {"task": request.task, "harness": "codex"})
        recorder.record("turn.started", {"turn": 1})
        recorder.record_tool_proposed(
            tool_call_id="tool-codex-1",
            tool_name="patch",
            arguments={"file": "src/main.rs"},
        )
        recorder.record_tool_settled(
            tool_call_id="tool-codex-1", success=True, result_artifact_hash=None
        )
        recorder.record("turn.completed", {"turn": 1})

        cost = self.cost or _default_adapter_cost(request.budgets, multiplier=1.0)
        return HarnessResult(
            outcome=self.outcome,
            final_revision=self.final_revision,
            cost=cost,
            artifacts=[],
            context_manifests=[],
            grader_outcomes=[],
            notes=self.notes,
        )


@dataclass
class PiAdapter:
    """Pi coding agent baseline harness."""

    final_revision: str = "release:pi@pinned"
    cost: CostBreakdown | None = None
    outcome: Outcome = Outcome.COMPLETED
    notes: str = "fixture-only Pi-shaped trace; not a live Pi run"

    def run(self, request: RunRequest, recorder: TrajectoryRecorder) -> HarnessResult:
        recorder.record("task.activated", {"task": request.task, "harness": "pi"})
        recorder.record("turn.started", {"turn": 1})
        recorder.record_tool_proposed(
            tool_call_id="tool-pi-1",
            tool_name="write",
            arguments={"path": "out.txt"},
        )
        recorder.record_tool_settled(
            tool_call_id="tool-pi-1", success=True, result_artifact_hash=None
        )
        recorder.record("turn.completed", {"turn": 1})

        cost = self.cost or _default_adapter_cost(request.budgets, multiplier=0.9)
        return HarnessResult(
            outcome=self.outcome,
            final_revision=self.final_revision,
            cost=cost,
            artifacts=[],
            context_manifests=[],
            grader_outcomes=[],
            notes=self.notes,
        )


@dataclass
class OhMyPiAdapter:
    """Oh My Pi agent baseline harness."""

    final_revision: str = "release:oh-my-pi@pinned"
    cost: CostBreakdown | None = None
    outcome: Outcome = Outcome.COMPLETED
    notes: str = "fixture-only Oh My Pi-shaped trace; not a live Oh My Pi run"

    def run(self, request: RunRequest, recorder: TrajectoryRecorder) -> HarnessResult:
        recorder.record("task.activated", {"task": request.task, "harness": "oh_my_pi"})
        recorder.record("turn.started", {"turn": 1})
        recorder.record_tool_proposed(
            tool_call_id="tool-omp-1",
            tool_name="edit",
            arguments={"path": "index.ts"},
        )
        recorder.record_tool_settled(
            tool_call_id="tool-omp-1", success=True, result_artifact_hash=None
        )
        recorder.record("turn.completed", {"turn": 1})

        cost = self.cost or _default_adapter_cost(request.budgets, multiplier=0.95)
        return HarnessResult(
            outcome=self.outcome,
            final_revision=self.final_revision,
            cost=cost,
            artifacts=[],
            context_manifests=[],
            grader_outcomes=[],
            notes=self.notes,
        )


@dataclass
class ClaudeCodeAdapter:
    """Claude Code CLI baseline harness."""

    final_revision: str = "release:claude-code@pinned"
    cost: CostBreakdown | None = None
    outcome: Outcome = Outcome.COMPLETED
    notes: str = "fixture-only Claude Code-shaped trace; not a live Claude Code run"

    def run(self, request: RunRequest, recorder: TrajectoryRecorder) -> HarnessResult:
        recorder.record("task.activated", {"task": request.task, "harness": "claude_code"})
        recorder.record("turn.started", {"turn": 1})
        recorder.record_tool_proposed(
            tool_call_id="tool-cc-1",
            tool_name="FileEdit",
            arguments={"file_path": "lib.rs"},
        )
        recorder.record_tool_settled(
            tool_call_id="tool-cc-1", success=True, result_artifact_hash=None
        )
        recorder.record("turn.completed", {"turn": 1})

        cost = self.cost or _default_adapter_cost(request.budgets, multiplier=1.15)
        return HarnessResult(
            outcome=self.outcome,
            final_revision=self.final_revision,
            cost=cost,
            artifacts=[],
            context_manifests=[],
            grader_outcomes=[],
            notes=self.notes,
        )


def get_baseline_harness(baseline_id: str, **kwargs: Any) -> Harness:
    """Return a runnable :class:`Harness` instance for ``baseline_id``.

    Raises ``ExternalHarnessUnavailable`` for required-but-unconfigured external
    comparisons and ``KeyError`` if ``baseline_id`` is unknown.
    """
    if baseline_id == "upstream_opencode":
        raise ExternalHarnessUnavailable(
            "OpenCode is an external comparison only; configure an exact pin and "
            "adapter-protocol runner before executing it"
        )
    adapters: dict[str, type[Harness]] = {
        "forge_minimal": TerminusMinimalAdapter,
        "forge_full": TerminusFullAdapter,
        "codex": CodexAdapter,
        "pi": PiAdapter,
        "oh_my_pi": OhMyPiAdapter,
        "claude_code": ClaudeCodeAdapter,
        "mini_swe_agent": MiniSweAgentAdapter,
    }
    if baseline_id not in adapters:
        raise KeyError(f"Unknown baseline harness id: {baseline_id!r}")

    if baseline_id == "mini_swe_agent" and "turns" not in kwargs:
        from .mini_swe_adapter import MiniSweAgentTurn

        kwargs["turns"] = [MiniSweAgentTurn(turn=1, command="ls", stdout="a.py\nb.py\n")]

    cls = adapters[baseline_id]
    return cls(**kwargs)


def _default_adapter_cost(budgets: Budgets, multiplier: float = 1.0) -> CostBreakdown:
    in_tok = int(1200 * multiplier)
    out_tok = int(350 * multiplier)
    computed = round((in_tok * 3.0 + out_tok * 15.0) / 1_000_000, 6)
    return CostBreakdown(
        provider_reported_usd=computed,
        computed_usd=computed,
        input_tokens=in_tok,
        output_tokens=out_tok,
        cached_tokens=0,
        reasoning_tokens=0,
        cache_write_tokens=0,
        cache_read_tokens=0,
    )

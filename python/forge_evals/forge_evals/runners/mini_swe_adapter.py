"""SPEC §3.7 mini-SWE-agent adapter.

The *mini-SWE-agent* is a permanent control arm (SPEC §3.7, §18.1). It is
an intentionally tiny Bash loop with **one model, Bash-like execution,
linear history, and no advanced retrieval, memory, or subagents**. It
remains a serious competitor even when its project-reported leaderboard
results are not independently reproduced.

This module provides :class:`MiniSweAgentAdapter`, a :class:`Harness`
implementation that simulates the mini-SWE-agent's bash-loop pattern.
It does **not** run a real model or a real bash subprocess; instead it
runs a *scripted* loop that emits the trajectory events a real
mini-SWE-agent would emit (one provider attempt per turn, one bash
tool call per turn, linear history). Pair it with the
:class:`FakeProvider` for fully deterministic runs.

The adapter exists so the cross-harness comparator
(:mod:`forge_evals.runners.cross_harness`) and the eval CLI can include
the mini-SWE-agent baseline without spinning up an external process.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from ..run_record import CostBreakdown, Outcome
from .fake_provider import FakeProvider, FakeProviderBuilder
from .harness_runner import (
    Budgets,
    GraderOutcome,
    HarnessResult,
    ModelCapabilitySnapshot,
    RunRequest,
)
from .trajectory_recorder import TrajectoryRecorder

__all__ = ["MiniSweAgentAdapter", "MiniSweAgentTurn"]


@dataclass(frozen=True)
class MiniSweAgentTurn:
    """A single turn in the mini-SWE-agent bash loop.

    The mini-SWE-agent has a deliberately narrow turn structure: the model
    emits exactly one bash command per turn, the harness runs it, and the
    result is appended to the linear history. There are no parallel
    sub-agents, no advanced retrieval, no memory compaction.
    """

    turn: int
    command: str
    stdout: str = ""
    stderr: str = ""
    exit_code: int = 0
    duration_seconds: float = 0.0


@dataclass
class MiniSweAgentAdapter:
    """A :class:`Harness` that simulates the mini-SWE-agent bash loop.

    The adapter is *scripted*: it takes a list of :class:`MiniSweAgentTurn`
    objects (or a :class:`FakeProvider` that emits them) and replays them
    as a linear trajectory. This makes it deterministic and dependency-free,
    suitable for the offline eval plane.

    Usage::

        adapter = MiniSweAgentAdapter(
            turns=[
                MiniSweAgentTurn(turn=1, command="ls", stdout="a.py\\nb.py\\n"),
                MiniSweAgentTurn(turn=2, command="cat a.py", stdout="x = 1\\n"),
                MiniSweAgentTurn(turn=3, command="echo 'y = 2' >> a.py", stdout=""),
            ],
            final_revision="deadbeef",
        )
        runner = HarnessRunner(harness=adapter)
        record = runner.run(request)
    """

    turns: list[MiniSweAgentTurn] = field(default_factory=list)
    final_revision: str = ""
    cost: CostBreakdown | None = None
    outcome: Outcome = Outcome.COMPLETED
    notes: str = "mini-SWE-agent bash loop (simulated)"
    #: Per-turn sleep (seconds) — set to a small value to simulate wall-clock.
    sleep_per_turn: float = 0.0
    #: Optional model capability snapshot for trajectory metadata.
    model_snapshot: ModelCapabilitySnapshot | None = None

    def run(self, request: RunRequest, recorder: TrajectoryRecorder) -> HarnessResult:
        """Replay the scripted turns as a linear bash-loop trajectory."""
        recorder.record("task.activated", {"task": request.task})
        self._build_provider()
        attempt_id = "mini-swe-1"
        for i, turn in enumerate(self.turns):
            recorder.record("turn.started", {"turn": turn.turn})
            recorder.record("turn.context_compiling", {"turn": turn.turn})
            recorder.record(
                "context.manifest_persisted",
                {
                    "manifest_id": f"mini-swe-turn-{turn.turn}",
                    "token_budget": request.budgets.max_input_tokens,
                    "fragment_count": 1 + i,  # linear history grows
                },
            )
            recorder.record("turn.provider_running", {"turn": turn.turn})
            recorder.record(
                "provider.request_sent",
                {
                    "attempt_id": attempt_id,
                    "turn": turn.turn,
                    "model": (
                        self.model_snapshot.model if self.model_snapshot else "mini-swe-model"
                    ),
                    "provider": (self.model_snapshot.provider if self.model_snapshot else "fake"),
                },
            )
            # Stream the model's response (the bash command) as a single text chunk.
            recorder.record_provider_chunk(
                attempt_id=attempt_id, chunk_kind="text", text=turn.command
            )
            # The mini-SWE-agent emits exactly one tool call per turn: bash.
            recorder.record_tool_proposed(
                tool_call_id=f"bash-{turn.turn}",
                tool_name="bash",
                arguments={"command": turn.command},
            )
            recorder.record_tool_authorized(
                tool_call_id=f"bash-{turn.turn}",
                decision="allow",
                rules=["allow-bash-linear-history"],
            )
            # Run the bash command (simulated — we already have the scripted output).
            if self.sleep_per_turn:
                time.sleep(self.sleep_per_turn)
            recorder.record_tool_settled(
                tool_call_id=f"bash-{turn.turn}",
                success=(turn.exit_code == 0),
                result_artifact_hash=None,
            )
            # Record the side-effect (the bash command) for graders to inspect.
            recorder.record(
                "side_effect.started",
                {
                    "effect_type": "exec",
                    "command": turn.command,
                    "via_proxy": False,
                },
            )
            recorder.record(
                "side_effect.settled",
                {
                    "effect_type": "exec",
                    "command": turn.command,
                    "exit_code": turn.exit_code,
                    "stdout": turn.stdout,
                    "stderr": turn.stderr,
                    "via_proxy": False,
                    "duration_seconds": turn.duration_seconds,
                },
            )
            recorder.record("turn.finalizing", {"turn": turn.turn})
            recorder.record("turn.completed", {"turn": turn.turn})
        # Build grader outcomes — the mini-SWE-agent itself does not grade;
        # the runner's graders (if any) handle that.
        grader_outcomes: list[GraderOutcome] = []
        return HarnessResult(
            outcome=self.outcome,
            final_revision=self.final_revision,
            cost=self.cost or _default_cost(self.turns, request.budgets),
            artifacts=[],
            context_manifests=[],
            grader_outcomes=grader_outcomes,
            notes=self.notes,
        )

    def _build_provider(self) -> FakeProvider:
        """Build a fake provider that streams the scripted commands."""
        builder = FakeProviderBuilder()
        for turn in self.turns:
            builder.text(turn.command)
        builder.done()
        return builder.build()


def _default_cost(turns: list[MiniSweAgentTurn], budgets: Budgets) -> CostBreakdown:
    """Build a default CostBreakdown for a mini-SWE-agent run.

    The mini-SWE-agent is intentionally cheap: one provider call per turn,
    small input/output token counts. We compute a synthetic cost from the
    number of turns and the configured max_input_tokens.
    """
    n_turns = len(turns)
    input_tokens = min(2000 * n_turns, budgets.max_input_tokens)
    output_tokens = min(100 * n_turns, budgets.max_output_tokens)
    # Mini-SWE-agent uses no cache, no reasoning tokens.
    computed = (input_tokens * 3.0 + output_tokens * 15.0) / 1_000_000
    return CostBreakdown(
        provider_reported_usd=round(computed, 6),
        computed_usd=round(computed, 6),
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cached_tokens=0,
        reasoning_tokens=0,
        cache_write_tokens=0,
        cache_read_tokens=0,
    )

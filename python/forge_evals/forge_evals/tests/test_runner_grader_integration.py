"""Integration tests for the grader-wiring in :class:`HarnessRunner`.

These tests verify that audit A3 fix #1 (wire security graders into the
runner) and fix #2 (trajectory payload stays a dict) work end-to-end with
both the :class:`FakeScriptHarness` and the :class:`MiniSweAgentAdapter`.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from forge_evals.graders.end_state import EndStateGraderInput, NoopGrader
from forge_evals.graders.security_graders import (
    NetworkBypassGrader,
    WorkspaceEscapeGrader,
)
from forge_evals.run_record import Outcome
from forge_evals.runners import (
    Budgets,
    FakeScriptHarness,
    GraderOutcome,
    HarnessResult,
    HarnessRunner,
    MiniSweAgentAdapter,
    MiniSweAgentTurn,
    ModelCapabilitySnapshot,
    RunRequest,
)


def _make_task_dir(d: Path) -> Path:
    """Build a minimal task package dir."""
    d.mkdir(parents=True, exist_ok=True)
    (d / "task.yaml").write_text("source_commit: abc123\nimage_digest: sha:img\n", encoding="utf-8")
    (d / "setup.sh").write_text("echo hi\n", encoding="utf-8")
    (d / "environment.lock").write_text("python=3.12\n", encoding="utf-8")
    return d


def _make_request(task_dir: Path) -> RunRequest:
    return RunRequest(
        suite="tiny_bugfix",
        task="t1",
        task_dir=task_dir,
        harness_id="terminus-minimal",
        harness_commit="abc",
        model_snapshot=ModelCapabilitySnapshot(
            provider="fake",
            model="fake-1",
            api_version="v1",
            context_window=128000,
            max_output_tokens=8192,
            supports_tool_calls=True,
            supports_streaming=True,
            supports_cache=True,
            pricing={"input": 3.0, "output": 15.0},
        ),
        random_seed=42,
        budgets=Budgets(),
    )


def _winning_harness_result() -> HarnessResult:
    return HarnessResult(
        outcome=Outcome.COMPLETED,
        final_revision="deadbeef",
        cost=None,
        artifacts=[],
        context_manifests=[],
        grader_outcomes=[
            GraderOutcome(
                grader_id="end_state.noop",
                grader_version="0.1.0",
                passed=True,
                score=1.0,
            )
        ],
    )


def test_runner_invokes_security_graders_after_run(tmp_path: Path) -> None:
    """HarnessRunner invokes each registered grader and collects results.

    Audit A3 fix #1: previously the runner never built an
    ``EndStateGraderInput`` and never called any grader, so production
    runs had empty ``grader_results`` for security.
    """
    task_dir = _make_task_dir(tmp_path / "task")
    harness = FakeScriptHarness(result=_winning_harness_result())
    runner = HarnessRunner(
        harness=harness,
        graders=[
            NoopGrader(),
            WorkspaceEscapeGrader(workspace_root=tmp_path),
            NetworkBypassGrader(),
        ],
        workspace_root=tmp_path,
    )
    rec = runner.run(_make_request(task_dir))
    # 1 harness-provided grader + 3 runner-invoked graders.
    assert len(rec.grader_results) == 4
    grader_ids = [g.grader_id for g in rec.grader_results]
    assert "end_state.noop" in grader_ids
    assert "security.workspace_escape" in grader_ids
    assert "security.network_bypass" in grader_ids
    # Security graders should pass on a clean run.
    for g in rec.grader_results:
        if g.grader_id.startswith("security."):
            assert g.passed, f"{g.grader_id} should pass: {g.evidence}"


def test_runner_grader_input_has_trajectory_as_dicts(tmp_path: Path) -> None:
    """The grader input's ``metadata['trajectory']`` has ``payload`` as dicts.

    Audit A3 fix #2: previously ``TrajectoryEvent.to_dict()`` JSON-encoded
    payload as a string, breaking ``isinstance(payload, dict)`` checks in
    graders' ``_iter_events`` helper.
    """
    task_dir = _make_task_dir(tmp_path / "task")
    captured: dict[str, Any] = {}

    class _CapturingGrader(NoopGrader):
        """A grader that captures the input it receives."""

        grader_id = "test.capturing"
        grader_version = "0.1.0"

        def grade(self, inp: EndStateGraderInput) -> Any:
            captured["trajectory"] = inp.metadata.get("trajectory", [])
            return super().grade(inp)

    harness = FakeScriptHarness(result=_winning_harness_result())
    runner = HarnessRunner(harness=harness, graders=[_CapturingGrader()])
    runner.run(_make_request(task_dir))
    traj = captured.get("trajectory")
    assert isinstance(traj, list)
    assert len(traj) > 0
    for ev in traj:
        assert isinstance(ev, dict)
        assert "payload" in ev
        # The key invariant: graders should receive payload as a dict, not a string.
        assert isinstance(ev["payload"], dict), (
            f"payload must be dict, got {type(ev['payload'])}: {ev!r}"
        )


def test_runner_grader_input_has_commands_and_files(tmp_path: Path) -> None:
    """The grader input extracts commands_executed and files_changed from the trajectory."""
    task_dir = _make_task_dir(tmp_path / "task")
    captured: dict[str, Any] = {}

    class _CapturingGrader(NoopGrader):
        grader_id = "test.capturing2"
        grader_version = "0.1.0"

        def grade(self, inp: EndStateGraderInput) -> Any:
            captured["commands"] = inp.metadata.get("commands_executed", [])
            captured["files"] = inp.metadata.get("files_changed", [])
            captured["objective"] = inp.objective
            captured["snapshot"] = inp.snapshot
            return super().grade(inp)

    adapter = MiniSweAgentAdapter(
        turns=[
            MiniSweAgentTurn(turn=1, command="ls", stdout="a.py\n"),
            MiniSweAgentTurn(turn=2, command="echo x > a.py", stdout=""),
        ],
        final_revision="deadbeef",
    )
    runner = HarnessRunner(harness=adapter, graders=[_CapturingGrader()])
    runner.run(_make_request(task_dir))
    commands = captured.get("commands")
    assert isinstance(commands, list)
    # The mini-SWE-agent ran 2 bash commands.
    assert len(commands) == 2
    assert "ls" in commands
    assert "echo x > a.py" in commands
    # Snapshot has the final revision.
    snap = captured.get("snapshot")
    assert snap is not None
    assert snap.final_revision == "deadbeef"
    # Objective is set.
    assert isinstance(captured.get("objective"), str)


def test_runner_grader_failure_does_not_mask_run(tmp_path: Path) -> None:
    """A grader that raises is recorded as a failed result, not propagated."""
    task_dir = _make_task_dir(tmp_path / "task")

    class _ExplodingGrader(NoopGrader):
        grader_id = "test.exploding"
        grader_version = "0.1.0"

        def grade(self, inp: EndStateGraderInput) -> Any:
            raise RuntimeError("boom")

    harness = FakeScriptHarness(result=_winning_harness_result())
    runner = HarnessRunner(harness=harness, graders=[_ExplodingGrader()])
    rec = runner.run(_make_request(task_dir))
    # Run completes successfully; the exploding grader is recorded as failed.
    assert rec.outcome is Outcome.COMPLETED
    exploding = [g for g in rec.grader_results if g.grader_id == "test.exploding"]
    assert len(exploding) == 1
    assert not exploding[0].passed
    assert any("RuntimeError" in e or "boom" in e for e in exploding[0].evidence)


def test_runner_without_graders_preserves_harness_outcomes(tmp_path: Path) -> None:
    """Without graders, only the harness's own grader outcomes are recorded."""
    task_dir = _make_task_dir(tmp_path / "task")
    harness = FakeScriptHarness(result=_winning_harness_result())
    runner = HarnessRunner(harness=harness)
    rec = runner.run(_make_request(task_dir))
    assert len(rec.grader_results) == 1
    assert rec.grader_results[0].grader_id == "end_state.noop"

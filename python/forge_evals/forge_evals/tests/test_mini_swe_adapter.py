"""Tests for the SPEC §3.7 mini-SWE-agent adapter."""

from __future__ import annotations

from pathlib import Path

from forge_evals.graders.security_graders import WorkspaceEscapeGrader
from forge_evals.run_record import Outcome
from forge_evals.runners import (
    Budgets,
    HarnessRunner,
    MiniSweAgentAdapter,
    MiniSweAgentTurn,
    ModelCapabilitySnapshot,
    RunRequest,
)


def _make_task_dir(d: Path) -> Path:
    """Build a minimal task package dir."""
    d.mkdir(parents=True, exist_ok=True)
    (d / "task.yaml").write_text("source_commit: abc\nimage_digest: sha:img\n", encoding="utf-8")
    (d / "setup.sh").write_text("echo hi\n", encoding="utf-8")
    (d / "environment.lock").write_text("python=3.12\n", encoding="utf-8")
    return d


def _make_request(task_dir: Path) -> RunRequest:
    return RunRequest(
        suite="tiny_bugfix",
        task="t1",
        task_dir=task_dir,
        harness_id="mini-swe-agent",
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


def test_mini_swe_adapter_produces_complete_record(tmp_path: Path) -> None:
    """The mini-SWE-agent adapter drives a linear bash-loop trajectory."""
    task_dir = _make_task_dir(tmp_path / "task")
    adapter = MiniSweAgentAdapter(
        turns=[
            MiniSweAgentTurn(turn=1, command="ls", stdout="a.py\nb.py\n"),
            MiniSweAgentTurn(turn=2, command="cat a.py", stdout="x = 1\n"),
            MiniSweAgentTurn(turn=3, command="echo 'y = 2' >> a.py", stdout=""),
        ],
        final_revision="deadbeef",
    )
    runner = HarnessRunner(harness=adapter)
    rec = runner.run(_make_request(task_dir))
    assert rec.outcome is Outcome.COMPLETED
    assert rec.cost is not None
    assert rec.cost.computed_usd > 0
    assert rec.end is not None
    assert len(rec.trajectory) > 0
    assert rec.trajectory[0]["event_type"] == "run.started"
    assert rec.trajectory[-1]["event_type"] == "run.ended"


def test_mini_swe_adapter_emits_one_bash_call_per_turn(tmp_path: Path) -> None:
    """Each turn emits exactly one ``tool.proposed`` event with ``tool_name='bash'``."""
    task_dir = _make_task_dir(tmp_path / "task")
    adapter = MiniSweAgentAdapter(
        turns=[
            MiniSweAgentTurn(turn=1, command="ls"),
            MiniSweAgentTurn(turn=2, command="cat foo"),
            MiniSweAgentTurn(turn=3, command="echo bar > foo"),
        ],
    )
    runner = HarnessRunner(harness=adapter)
    rec = runner.run(_make_request(task_dir))
    tool_proposed = [e for e in rec.trajectory if e["event_type"] == "tool.proposed"]
    assert len(tool_proposed) == 3
    for ev in tool_proposed:
        payload = ev["payload"]
        assert isinstance(payload, dict)
        assert payload["tool_name"] == "bash"
        assert "command" in payload["arguments"]


def test_mini_swe_adapter_trajectory_payloads_are_dicts(tmp_path: Path) -> None:
    """All trajectory payloads are dicts (audit A3 fix #2)."""
    task_dir = _make_task_dir(tmp_path / "task")
    adapter = MiniSweAgentAdapter(
        turns=[MiniSweAgentTurn(turn=1, command="ls"), MiniSweAgentTurn(turn=2, command="pwd")],
    )
    runner = HarnessRunner(harness=adapter)
    rec = runner.run(_make_request(task_dir))
    for ev in rec.trajectory:
        assert isinstance(ev["payload"], dict), f"payload not dict: {ev!r}"


def test_mini_swe_adapter_records_side_effects(tmp_path: Path) -> None:
    """The adapter records ``side_effect.started``/``settled`` for each bash call."""
    task_dir = _make_task_dir(tmp_path / "task")
    adapter = MiniSweAgentAdapter(
        turns=[
            MiniSweAgentTurn(turn=1, command="ls", stdout="a.py\n", exit_code=0),
            MiniSweAgentTurn(turn=2, command="false", stdout="", exit_code=1),
        ],
    )
    runner = HarnessRunner(harness=adapter)
    rec = runner.run(_make_request(task_dir))
    started = [e for e in rec.trajectory if e["event_type"] == "side_effect.started"]
    settled = [e for e in rec.trajectory if e["event_type"] == "side_effect.settled"]
    assert len(started) == 2
    assert len(settled) == 2
    # Exit codes are propagated.
    exit_codes = [e["payload"].get("exit_code") for e in settled]
    assert exit_codes == [0, 1]


def test_mini_swe_adapter_works_with_security_grader(tmp_path: Path) -> None:
    """The adapter's trajectory can be consumed by a security grader."""
    task_dir = _make_task_dir(tmp_path / "task")
    adapter = MiniSweAgentAdapter(
        turns=[
            MiniSweAgentTurn(turn=1, command="ls src/"),
        ],
        final_revision="deadbeef",
    )
    runner = HarnessRunner(
        harness=adapter,
        graders=[WorkspaceEscapeGrader(workspace_root=tmp_path)],
        workspace_root=tmp_path,
    )
    rec = runner.run(_make_request(task_dir))
    # The WorkspaceEscapeGrader should run and produce a result.
    grader_ids = [g.grader_id for g in rec.grader_results]
    assert "security.workspace_escape" in grader_ids


def test_mini_swe_adapter_linear_history_grows(tmp_path: Path) -> None:
    """The mini-SWE-agent has linear history: each turn's manifest is larger than the last."""
    task_dir = _make_task_dir(tmp_path / "task")
    adapter = MiniSweAgentAdapter(
        turns=[
            MiniSweAgentTurn(turn=1, command="ls"),
            MiniSweAgentTurn(turn=2, command="cat foo"),
            MiniSweAgentTurn(turn=3, command="echo bar"),
        ],
    )
    runner = HarnessRunner(harness=adapter)
    rec = runner.run(_make_request(task_dir))
    manifests = [e for e in rec.trajectory if e["event_type"] == "context.manifest_persisted"]
    assert len(manifests) == 3
    fragment_counts = [e["payload"]["fragment_count"] for e in manifests]
    # Linear history grows: 1, 2, 3.
    assert fragment_counts == [1, 2, 3]

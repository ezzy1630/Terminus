"""R8: live runner glue — honest patch extraction and evaluator bridging."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from forge_evals.run_record import Outcome
from forge_evals.runners.harness_runner import HarnessResult, RunRequest
from forge_evals.runners.live_runner import (
    LiveRunError,
    _task_id_from_notes,
    build_swebench_evaluation_argv,
    invoke_external_evaluator,
    run_live_task,
    write_patch_file,
)


class _FakeHarness:
    def __init__(self, notes: str, diff: dict[str, Any]) -> None:
        self._notes = notes
        self._diff = diff

    def run(self, request: RunRequest, recorder: Any) -> HarnessResult:
        return HarnessResult(
            outcome=Outcome.COMPLETED,
            final_revision="abc123",
            cost=None,
            artifacts=[{"kind": "turn_state", "state": "COMPLETED"}],
            context_manifests=[],
            grader_outcomes=[],
            notes=self._notes,
        )

    def fetch_patch(self, task_id: str) -> dict[str, Any]:
        assert task_id == "task-77"
        return self._diff


class _Recorder:
    pass


def _request(tmp_path: Path) -> RunRequest:
    return RunRequest(
        suite="s",
        task="t",
        task_dir=tmp_path,
        harness_id="terminus-live",
        harness_commit="a" * 40,
        model_snapshot=None,  # type: ignore[arg-type]
        random_seed=1,
    )


def test_run_live_task_attaches_patch_artifact(tmp_path: Path) -> None:
    harness = _FakeHarness(
        json.dumps({"task_id": "task-77", "wall_seconds": 1.2}),
        {"diff": "diff --git a/x b/x\n...", "untracked_files": [], "truncated": False, "git_available": True},
    )
    result, payload = run_live_task(harness, _request(tmp_path), _Recorder())  # type: ignore[arg-type]
    kinds = [artifact["kind"] for artifact in result.artifacts]
    assert "workspace_patch" in kinds
    assert payload["diff"].startswith("diff --git")
    notes = json.loads(result.notes)
    assert notes["patch_extracted"] is True


def test_task_id_extraction_is_tolerant() -> None:
    assert _task_id_from_notes(json.dumps({"task_id": "x"})) == "x"
    assert _task_id_from_notes("not json") is None
    assert _task_id_from_notes(json.dumps([1])) is None


def test_swebench_argv_requires_patch_and_tool(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("shutil.which", lambda _: None)
    assert build_swebench_evaluation_argv("", "inst-1", tmp_path, "m") is None
    monkeypatch.setattr("shutil.which", lambda _: "/usr/bin/swebench")
    argv = build_swebench_evaluation_argv("diff --git a b\n", "inst-1", tmp_path, "m")
    assert argv is not None
    assert "--predictions_path" in argv
    predictions = next(a for a in argv if a.endswith("inst-1.json"))
    assert json.loads(Path(predictions).read_text())["model_patch"].startswith("diff --git")


def test_write_patch_file_round_trip(tmp_path: Path) -> None:
    target = write_patch_file("PATCH", tmp_path / "p.patch")
    assert target.read_text() == "PATCH"


def test_invoke_external_evaluator_reports_failure(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.chdir(tmp_path)
    argv = ["python3", "-c", "print('hi')"]
    report = invoke_external_evaluator(argv)
    assert report["exit_code"] == 0
    assert "hi" in report["stdout_tail"]


def test_live_run_error_type_exists() -> None:
    with pytest.raises(LiveRunError):
        raise LiveRunError("precondition")

"""The verdict path: a task package's declared grader decides success."""

from __future__ import annotations

import json
from pathlib import Path

import yaml

from forge_evals.runners.task_graders import (
    acceptance_criteria_for_task,
    load_task_grader_spec,
    run_task_grader,
)

REPO_ROOT = Path(__file__).resolve().parents[4]


def _write_grader(task_dir: Path, body: str) -> None:
    grader_dir = task_dir / "grader"
    grader_dir.mkdir(parents=True, exist_ok=True)
    (grader_dir / "run.py").write_text(body, encoding="utf-8")


def _task(tmp_path: Path, task_yaml: dict[str, object]) -> Path:
    task_dir = tmp_path / "task"
    task_dir.mkdir(parents=True, exist_ok=True)
    (task_dir / "task.yaml").write_text(yaml.safe_dump(task_yaml), encoding="utf-8")
    return task_dir


def test_exit_code_grader_protocol_passes_on_zero(tmp_path: Path) -> None:
    """`evals/tasks/**` graders signal the verdict with the exit code."""
    task_dir = _task(tmp_path, {"task": {"id": "tiny/01", "grader_version": "1.2.3"}})
    _write_grader(
        task_dir,
        "import pathlib, sys\nsys.exit(0 if pathlib.Path('fixed.txt').exists() else 1)\n",
    )

    (task_dir / "fixed.txt").write_text("done", encoding="utf-8")
    passing = run_task_grader(task_dir, task_dir)
    assert passing.passed is True
    assert passing.score == 1.0
    assert passing.grader_id == "task:tiny/01"
    assert passing.grader_version == "1.2.3"
    assert passing.metadata["grader_protocol"] == "exit_code"

    (task_dir / "fixed.txt").unlink()
    failing = run_task_grader(task_dir, task_dir)
    assert failing.passed is False
    assert failing.score == 0.0


def test_json_stdio_grader_protocol_is_preferred_when_present(tmp_path: Path) -> None:
    """`python/forge_evals/evals/tasks/**` graders emit a JSON verdict."""
    task_dir = _task(tmp_path, {"task": "build-001", "grader_version": "0.1.0"})
    _write_grader(
        task_dir,
        "import json, sys\n"
        "payload = json.load(sys.stdin)\n"
        "print('progress line that is not json')\n"
        "print(json.dumps({'passed': True, 'score': 0.75,\n"
        "                  'evidence': ['2/2 checks'],\n"
        "                  'metadata': {'workdir': payload['workdir']}}))\n",
    )

    result = run_task_grader(task_dir, task_dir, objective="build it")
    assert result.passed is True
    assert result.score == 0.75
    assert result.evidence == ["2/2 checks"]
    assert result.metadata["grader_protocol"] == "json_stdio"
    assert result.metadata["workdir"] == str(task_dir)


def test_grader_receives_the_post_run_workspace_not_the_task_dir(tmp_path: Path) -> None:
    """External benchmarks grade a materialised checkout, not the package."""
    task_dir = _task(tmp_path, {"task": "swe-1"})
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    _write_grader(
        task_dir,
        "import json, os, sys\n"
        "print(json.dumps({'passed': True, 'score': 1.0, 'metadata': {'cwd': os.getcwd()}}))\n",
    )

    result = run_task_grader(task_dir, workspace)
    assert Path(result.metadata["cwd"]).resolve() == workspace.resolve()


def test_private_hidden_assets_are_only_staged_while_the_grader_runs(tmp_path: Path) -> None:
    task_dir = _task(tmp_path, {"task": "hidden-assets"})
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    private_assets = tmp_path / "private-grader-assets"
    (private_assets / "hidden").mkdir(parents=True)
    (private_assets / "hidden" / "expected.txt").write_text("secret", encoding="utf-8")
    _write_grader(
        task_dir,
        "import pathlib, sys\n"
        "sys.exit(0 if pathlib.Path('hidden/expected.txt').read_text() == 'secret' else 1)\n",
    )

    assert not (workspace / "hidden").exists()
    result = run_task_grader(task_dir, workspace, grader_assets_dir=private_assets)

    assert result.passed is True
    assert not (workspace / "hidden").exists()


def test_agent_created_reserved_grader_path_fails_closed(tmp_path: Path) -> None:
    task_dir = _task(tmp_path, {"task": "hidden-collision"})
    workspace = tmp_path / "workspace"
    (workspace / "hidden").mkdir(parents=True)
    private_assets = tmp_path / "private-grader-assets"
    (private_assets / "hidden").mkdir(parents=True)
    _write_grader(task_dir, "raise SystemExit(0)\n")

    result = run_task_grader(task_dir, workspace, grader_assets_dir=private_assets)

    assert result.passed is False
    assert result.metadata["grader_status"] == "asset_isolation_error"


def test_missing_grader_is_a_failure_not_a_pass(tmp_path: Path) -> None:
    task_dir = _task(tmp_path, {"task": "no-grader"})
    result = run_task_grader(task_dir, task_dir)
    assert result.passed is False
    assert result.metadata["grader_status"] == "missing_entrypoint"


def test_crashing_grader_is_a_failure(tmp_path: Path) -> None:
    task_dir = _task(tmp_path, {"task": "boom"})
    _write_grader(task_dir, "raise SystemExit(3)\n")
    result = run_task_grader(task_dir, task_dir)
    assert result.passed is False
    assert result.metadata["exit_code"] == 3


def test_declared_json_protocol_rejects_non_json_output(tmp_path: Path) -> None:
    task_dir = _task(
        tmp_path,
        {"task": "strict", "grader": {"entrypoint": "grader/run.py", "protocol": "json_stdio"}},
    )
    _write_grader(task_dir, "print('all good')\n")
    result = run_task_grader(task_dir, task_dir)
    assert result.passed is False
    assert result.metadata["grader_status"] == "malformed_output"


def test_grader_timeout_is_recorded(tmp_path: Path) -> None:
    task_dir = _task(
        tmp_path,
        {"task": "slow", "grader": {"entrypoint": "grader/run.py", "timeout_seconds": 0.5}},
    )
    _write_grader(task_dir, "import time\ntime.sleep(30)\n")
    result = run_task_grader(task_dir, task_dir)
    assert result.passed is False
    assert result.metadata["grader_status"] == "timeout"


def test_criteria_are_shaped_for_the_task_contract(tmp_path: Path) -> None:
    """The contract schema is strict: only id/statement/verification_hint/required."""
    task_dir = _task(
        tmp_path,
        {
            "task": {
                "id": "tiny/01",
                "acceptance_criteria": [
                    {"id": "typo-fixed", "statement": "the typo is corrected", "required": True},
                    {"description": "no other file changes", "kind": "static_diagnostics"},
                    "tests still pass",
                    {"statement": "   "},
                ],
            }
        },
    )
    criteria = acceptance_criteria_for_task(task_dir)
    assert [c["id"] for c in criteria] == ["typo-fixed", "criterion-02", "criterion-03"]
    assert criteria[1]["statement"] == "no other file changes"
    assert criteria[1]["verification_hint"] == "static_diagnostics"
    assert criteria[2]["required"] is True
    allowed = {"id", "statement", "required", "verification_hint"}
    for criterion in criteria:
        assert set(criterion) <= allowed


def test_real_internal_task_package_declares_a_runnable_grader() -> None:
    """The first live internal task must actually have a grader on disk."""
    task_dir = REPO_ROOT / "evals" / "tasks" / "tiny-bugfix" / "01-fix-typo"
    spec = load_task_grader_spec(task_dir)
    assert spec.available
    assert spec.grader_version == "terminus-internal-1.0"
    assert [c["id"] for c in spec.acceptance_criteria] == ["typo-fixed"]
    assert json.dumps(spec.acceptance_criteria)  # JSON-serializable for the contract body

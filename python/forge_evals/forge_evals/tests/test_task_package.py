"""Tests for the SPEC §41.4 task-package loader."""

from __future__ import annotations

from pathlib import Path

import pytest

from forge_evals.task_package import TaskPackageError, load_task_package


def _make_minimal_pkg(d: Path) -> Path:
    """Build a minimal valid task package directory."""
    d.mkdir(parents=True, exist_ok=True)
    (d / "task.yaml").write_text(
        "source_commit: abc123\n"
        "image_digest: sha256:img\n"
        "timeout: 600\n"
        "budget:\n"
        "  max_cost_usd: 5.0\n"
        "allowed_network:\n"
        "  - pypi.org\n"
        "secrets:\n"
        "  API_KEY: supersecret\n"
        "grader_version: 0.2.0\n",
        encoding="utf-8",
    )
    (d / "prompt.md").write_text("# Task\n\nFix the bug.\n", encoding="utf-8")
    (d / "environment.lock").write_text("python=3.12\n", encoding="utf-8")
    (d / "setup.sh").write_text("#!/bin/bash\necho setup\n", encoding="utf-8")
    (d / "grader").mkdir(exist_ok=True)
    (d / "grader" / "run.py").write_text(
        "import json, sys\n"
        "data = json.load(sys.stdin)\n"
        "print(json.dumps({'passed': True, 'score': 1.0, 'evidence': ['ok']}))\n",
        encoding="utf-8",
    )
    (d / "hidden").mkdir(exist_ok=True)
    (d / "hidden" / "test_hidden.py").write_text(
        "def test_hidden():\n    assert True\n", encoding="utf-8"
    )
    (d / "expected-properties.yaml").write_text("primary_score_band: 0.7-1.0\n", encoding="utf-8")
    (d / "policy.yaml").write_text(
        "default: allow_local\ndeny:\n  - /etc/passwd\n", encoding="utf-8"
    )
    (d / "README.md").write_text("# Sample task\n", encoding="utf-8")
    return d


def test_load_task_package_parses_all_fields(tmp_path: Path) -> None:
    """load_task_package parses every required and optional file."""
    suite_dir = tmp_path / "my-suite"
    suite_dir.mkdir()
    d = _make_minimal_pkg(suite_dir / "my-task")
    pkg = load_task_package(d)
    assert pkg.suite == "my-suite"  # parent dir name
    assert pkg.task == "my-task"
    assert pkg.source_commit == "abc123"
    assert pkg.image_digest == "sha256:img"
    assert pkg.timeout == 600
    assert pkg.budget == {"max_cost_usd": 5.0}
    assert pkg.allowed_network == ["pypi.org"]
    assert pkg.secrets == {"API_KEY": "supersecret"}
    assert pkg.grader_version == "0.2.0"
    assert "Fix the bug" in pkg.prompt
    assert pkg.environment_lock == "python=3.12\n"
    assert "echo setup" in pkg.setup_script
    assert pkg.grader_dir.exists()
    assert pkg.grader_run_py.exists()
    assert pkg.hidden_dir.exists()
    assert (pkg.hidden_dir / "test_hidden.py").exists()
    assert pkg.expected_properties == {"primary_score_band": "0.7-1.0"}
    assert pkg.policy == {"default": "allow_local", "deny": ["/etc/passwd"]}
    assert "Sample task" in pkg.readme
    assert pkg.raw_task["source_commit"] == "abc123"


def test_load_task_package_to_dict_does_not_leak_secrets(tmp_path: Path) -> None:
    """to_dict masks secret values."""
    d = _make_minimal_pkg(tmp_path / "leak")
    pkg = load_task_package(d)
    out = pkg.to_dict()
    assert out["secrets"] == {"API_KEY": "***"}
    assert "supersecret" not in str(out)


def test_load_task_package_missing_dir_raises(tmp_path: Path) -> None:
    """Missing directory raises TaskPackageError."""
    with pytest.raises(TaskPackageError):
        load_task_package(tmp_path / "nope")


def test_load_task_package_missing_task_yaml_raises(tmp_path: Path) -> None:
    """Missing task.yaml raises TaskPackageError."""
    d = tmp_path / "incomplete"
    d.mkdir()
    (d / "prompt.md").write_text("hi", encoding="utf-8")
    with pytest.raises(TaskPackageError):
        load_task_package(d)


def test_load_task_package_missing_prompt_raises(tmp_path: Path) -> None:
    """Missing prompt.md raises TaskPackageError."""
    d = tmp_path / "incomplete2"
    d.mkdir()
    (d / "task.yaml").write_text("source_commit: x\n", encoding="utf-8")
    with pytest.raises(TaskPackageError):
        load_task_package(d)


def test_load_task_package_defaults_for_missing_optional_files(tmp_path: Path) -> None:
    """Missing optional files default to empty values."""
    d = tmp_path / "min"
    d.mkdir()
    (d / "task.yaml").write_text("source_commit: x\nimage_digest: y\n", encoding="utf-8")
    (d / "prompt.md").write_text("prompt", encoding="utf-8")
    pkg = load_task_package(d)
    assert pkg.environment_lock == ""
    assert pkg.setup_script == ""
    assert pkg.expected_properties == {}
    assert pkg.policy == {}
    assert pkg.readme == ""
    assert pkg.timeout == 1800  # default
    assert pkg.grader_version == "0.1.0"  # default
    assert pkg.allowed_network == []
    assert pkg.secrets == {}


def test_load_task_package_invalid_budget_raises(tmp_path: Path) -> None:
    """Invalid budget type raises TaskPackageError."""
    d = tmp_path / "bad"
    d.mkdir()
    (d / "task.yaml").write_text(
        "source_commit: x\nimage_digest: y\nbudget: not-a-mapping\n", encoding="utf-8"
    )
    (d / "prompt.md").write_text("p", encoding="utf-8")
    with pytest.raises(TaskPackageError):
        load_task_package(d)


def test_load_task_package_suite_and_task_override(tmp_path: Path) -> None:
    """task.yaml can override the default suite and task names."""
    d = tmp_path / "dir-name"
    d.mkdir()
    (d / "task.yaml").write_text(
        "suite: cross-file-feature\ntask: feat-001\nsource_commit: x\nimage_digest: y\n",
        encoding="utf-8",
    )
    (d / "prompt.md").write_text("p", encoding="utf-8")
    pkg = load_task_package(d)
    assert pkg.suite == "cross-file-feature"
    assert pkg.task == "feat-001"

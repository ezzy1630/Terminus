"""End-state grader tests (SPEC §41.5)."""

from __future__ import annotations

import os
import subprocess
import textwrap
from pathlib import Path

import pytest

from forge_evals.graders.end_state import (
    DiffGrader,
    EndStateGraderInput,
    FileContainsGrader,
    HiddenTestGrader,
    NoopGrader,
    PassFailGrader,
    ScriptGrader,
    TestRunGrader,
    WorkspaceSnapshot,
    parse_pytest_summary,
)


def _make_input(workdir: Path, **extra: object) -> EndStateGraderInput:
    """Build an EndStateGraderInput with sensible defaults."""
    snap = WorkspaceSnapshot(
        workdir=workdir,
        final_revision="deadbeef",
        baseline_revision="cafef00d",
    )
    return EndStateGraderInput(
        snapshot=snap,
        objective="test objective",
        acceptance_criteria=["criterion 1"],
        risk_class="normal",
        metadata=dict(extra),
    )


def test_noop_grader_always_passes(tmp_path: Path) -> None:
    """NoopGrader returns passed=True score=1.0."""
    inp = _make_input(tmp_path)
    g = NoopGrader()
    res = g.grade(inp)
    assert res.passed
    assert res.score == 1.0


def test_file_contains_grader_passes_when_required_present(tmp_path: Path) -> None:
    """FileContainsGrader passes when all required substrings are present."""
    (tmp_path / "main.py").write_text("def add(a, b):\n    return a + b\n", encoding="utf-8")
    inp = _make_input(tmp_path)
    g = FileContainsGrader(path="main.py", required_substrings=["def add", "return a + b"])
    res = g.grade(inp)
    assert res.passed
    assert res.score == 1.0


def test_file_contains_grader_fails_when_required_absent(tmp_path: Path) -> None:
    """FileContainsGrader fails when a required substring is missing."""
    (tmp_path / "main.py").write_text("def add(a, b):\n    return a - b\n", encoding="utf-8")
    inp = _make_input(tmp_path)
    g = FileContainsGrader(path="main.py", required_substrings=["def add", "return a + b"])
    res = g.grade(inp)
    assert not res.passed
    assert res.score == 0.5  # 1 of 2 required present.


def test_file_contains_grader_fails_when_forbidden_present(tmp_path: Path) -> None:
    """FileContainsGrader fails when a forbidden substring is present."""
    (tmp_path / "main.py").write_text("password = 'hunter2'\n", encoding="utf-8")
    inp = _make_input(tmp_path)
    g = FileContainsGrader(
        path="main.py",
        required_substrings=["password"],
        forbidden_substrings=["hunter2"],
    )
    res = g.grade(inp)
    assert not res.passed


def test_file_contains_grader_missing_file_fails(tmp_path: Path) -> None:
    """Missing target file → fail with score 0.0."""
    inp = _make_input(tmp_path)
    g = FileContainsGrader(path="missing.py", required_substrings=["x"])
    res = g.grade(inp)
    assert not res.passed
    assert res.score == 0.0


def test_pass_fail_grader_uses_predicate(tmp_path: Path) -> None:
    """PassFailGrader delegates to the predicate."""
    inp = _make_input(tmp_path)
    g = PassFailGrader(predicate=lambda i: (True, 0.7, ["ok"]))
    res = g.grade(inp)
    assert res.passed
    assert res.score == 0.7
    assert res.evidence == ["ok"]


def test_test_run_grader_passes_on_zero_exit(tmp_path: Path) -> None:
    """TestRunGrader passes when the command exits 0."""
    (tmp_path / "test.py").write_text("print('ok')\n", encoding="utf-8")
    inp = _make_input(tmp_path)
    g = TestRunGrader(command=["python3", "test.py"], timeout_seconds=10)
    res = g.grade(inp)
    assert res.passed
    assert res.score == 1.0


def test_test_run_grader_fails_on_nonzero_exit(tmp_path: Path) -> None:
    """TestRunGrader fails when the command exits non-zero."""
    (tmp_path / "test.py").write_text("import sys; sys.exit(1)\n", encoding="utf-8")
    inp = _make_input(tmp_path)
    g = TestRunGrader(command=["python3", "test.py"], timeout_seconds=10)
    res = g.grade(inp)
    assert not res.passed
    assert res.score == 0.0


def test_test_run_grader_times_out(tmp_path: Path) -> None:
    """TestRunGrader returns timeout failure for long-running commands."""
    (tmp_path / "test.py").write_text("import time; time.sleep(10)\n", encoding="utf-8")
    inp = _make_input(tmp_path)
    g = TestRunGrader(command=["python3", "test.py"], timeout_seconds=1)
    res = g.grade(inp)
    assert not res.passed
    assert "timeout" in res.evidence[0].lower()


def test_test_run_grader_handles_missing_command(tmp_path: Path) -> None:
    """TestRunGrader handles FileNotFoundError gracefully."""
    inp = _make_input(tmp_path)
    g = TestRunGrader(command=["nonexistent-command-xyz"], timeout_seconds=5)
    res = g.grade(inp)
    assert not res.passed
    assert any("not found" in e for e in res.evidence)


def test_parse_pytest_summary_extracts_counts() -> None:
    """parse_pytest_summary correctly extracts passed/failed/skipped counts."""
    stdout = "=== 30 passed, 2 failed, 1 skipped in 5.0s ==="
    score, evidence = parse_pytest_summary(stdout, exit_code=1)
    assert score == pytest.approx(30 / 32)
    assert "passed=30" in evidence[0]
    assert "failed=2" in evidence[0]


def test_parse_pytest_summary_no_tests() -> None:
    """parse_pytest_summary returns 1.0 for no tests with exit 0."""
    score, _ = parse_pytest_summary("no tests ran", exit_code=0)
    assert score == 1.0


def test_hidden_test_grader_missing_dir_fails(tmp_path: Path) -> None:
    """HiddenTestGrader fails when the hidden dir doesn't exist."""
    inp = _make_input(tmp_path)
    g = HiddenTestGrader(
        hidden_dir=tmp_path / "missing_hidden",
        command=["python3", "-m", "pytest"],
    )
    res = g.grade(inp)
    assert not res.passed
    assert any("not found" in e for e in res.evidence)


def test_hidden_test_grader_runs_command(tmp_path: Path) -> None:
    """HiddenTestGrader runs the command and respects exit code."""
    hidden = tmp_path / "hidden"
    hidden.mkdir()
    (hidden / "test_hidden.py").write_text("print('hidden test passed')\n", encoding="utf-8")
    (tmp_path / "runner.sh").write_text(
        "#!/bin/bash\necho HIDDEN_DIR=$HIDDEN_DIR\nexit 0\n", encoding="utf-8"
    )
    os.chmod(tmp_path / "runner.sh", 0o755)
    inp = _make_input(tmp_path)
    g = HiddenTestGrader(
        hidden_dir=hidden,
        command=["bash", str(tmp_path / "runner.sh")],
    )
    res = g.grade(inp)
    assert res.passed


def test_diff_grader_passes_when_diff_within_limits(tmp_path: Path) -> None:
    """DiffGrader passes when added/removed lines are within limits."""
    # Initialize a git repo so the diff command works.
    _init_git_repo(tmp_path)
    # Make one small change.
    (tmp_path / "main.py").write_text("x = 1\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=tmp_path, check=True)
    subprocess.run(["git", "commit", "-m", "c2"], cwd=tmp_path, check=True, capture_output=True)
    new_commit = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=tmp_path, text=True
    ).strip()
    base_commit = subprocess.check_output(
        ["git", "rev-parse", "HEAD~1"], cwd=tmp_path, text=True
    ).strip()
    inp = EndStateGraderInput(
        snapshot=WorkspaceSnapshot(
            workdir=tmp_path, final_revision=new_commit, baseline_revision=base_commit
        ),
        objective="o",
        acceptance_criteria=[],
    )
    g = DiffGrader(max_added_lines=100, max_removed_lines=100)
    res = g.grade(inp)
    assert res.passed


def test_diff_grader_fails_when_diff_exceeds_limits(tmp_path: Path) -> None:
    """DiffGrader fails when added lines exceed the limit."""
    _init_git_repo(tmp_path)
    (tmp_path / "main.py").write_text(
        "\n".join(f"line{i}" for i in range(50)) + "\n", encoding="utf-8"
    )
    subprocess.run(["git", "add", "."], cwd=tmp_path, check=True)
    subprocess.run(["git", "commit", "-m", "c2"], cwd=tmp_path, check=True, capture_output=True)
    new_commit = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=tmp_path, text=True
    ).strip()
    base_commit = subprocess.check_output(
        ["git", "rev-parse", "HEAD~1"], cwd=tmp_path, text=True
    ).strip()
    inp = EndStateGraderInput(
        snapshot=WorkspaceSnapshot(
            workdir=tmp_path, final_revision=new_commit, baseline_revision=base_commit
        ),
        objective="o",
        acceptance_criteria=[],
    )
    g = DiffGrader(max_added_lines=10, max_removed_lines=10)
    res = g.grade(inp)
    assert not res.passed


def test_script_grader_parses_json_output(tmp_path: Path) -> None:
    """ScriptGrader parses a JSON object from stdout."""
    script_path = tmp_path / "grader.sh"
    script_path.write_text(
        textwrap.dedent(
            """\
            #!/bin/bash
            cat <<EOF
            {"passed": true, "score": 0.9, "evidence": ["e1"], "metadata": {"k": "v"}}
            EOF
            """
        ),
        encoding="utf-8",
    )
    os.chmod(script_path, 0o755)
    inp = _make_input(tmp_path)
    g = ScriptGrader(script=["bash", str(script_path)])
    res = g.grade(inp)
    assert res.passed
    assert res.score == 0.9
    assert res.evidence == ["e1"]
    assert res.metadata == {"k": "v"}


def test_script_grader_handles_nonzero_exit(tmp_path: Path) -> None:
    """ScriptGrader handles non-zero exit codes."""
    script_path = tmp_path / "grader.sh"
    script_path.write_text("#!/bin/bash\nexit 2\n", encoding="utf-8")
    os.chmod(script_path, 0o755)
    inp = _make_input(tmp_path)
    g = ScriptGrader(script=["bash", str(script_path)])
    res = g.grade(inp)
    assert not res.passed


def _init_git_repo(d: Path) -> None:
    """Initialize a tiny git repo with one initial commit."""
    subprocess.run(["git", "init", "-q"], cwd=d, check=True)
    subprocess.run(["git", "config", "user.email", "t@t"], cwd=d, check=True)
    subprocess.run(["git", "config", "user.name", "t"], cwd=d, check=True)
    subprocess.run(["git", "config", "commit.gpgsign", "false"], cwd=d, check=True)
    (d / "main.py").write_text("# initial\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=d, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "c1"], cwd=d, check=True, capture_output=True)

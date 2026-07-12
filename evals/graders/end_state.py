"""End-state grader for Terminus eval tasks.

This module provides the canonical end-state grader used by the eval
harness. It runs the task-specific grader (grader/run.py) inside the
sandbox, captures its stdout/stderr, and produces a structured
EndStateResult consumable by the promotion gate.

End-state grading is the SOURCE OF TRUTH for task outcome. Inner-harness
self-report is not sufficient evidence (SPEC §35.12).
"""
from __future__ import annotations

import dataclasses
import json
import pathlib
import subprocess
import sys
from typing import Any


@dataclasses.dataclass(frozen=True)
class EndStateResult:
    """Structured result of an end-state grading run."""

    task_id: str
    outcome: str  # "passed" | "failed" | "error" | "skipped"
    summary: str
    stdout: str
    stderr: str
    artifacts: list[str]
    extra: dict[str, Any]

    @property
    def passed(self) -> bool:
        return self.outcome == "passed"

    def to_dict(self) -> dict[str, Any]:
        return dataclasses.asdict(self)


def grade_end_state(task_dir: pathlib.Path, timeout_seconds: int = 120) -> EndStateResult:
    """Run grader/run.py in task_dir and parse the result.

    The task grader is the canonical truth. This wrapper:
      1. Verifies grader/run.py exists.
      2. Runs it with the active Python interpreter.
      3. Captures stdout/stderr.
      4. Maps exit code 0 -> "passed", non-zero -> "failed", timeout -> "error".
      5. Returns a structured EndStateResult.

    This function does NOT trust any "I'm done" signal from the agent
    or the inner harness. It re-derives outcome from the workspace state.
    """
    grader = task_dir / "grader" / "run.py"
    if not grader.exists():
        return EndStateResult(
            task_id=task_dir.name,
            outcome="error",
            summary=f"grader not found at {grader}",
            stdout="",
            stderr="",
            artifacts=[],
            extra={"missing_grader": str(grader)},
        )

    try:
        result = subprocess.run(
            [sys.executable, str(grader)],
            cwd=task_dir,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired as e:
        return EndStateResult(
            task_id=task_dir.name,
            outcome="error",
            summary=f"grader timed out after {timeout_seconds}s",
            stdout=(e.stdout or b"").decode("utf-8", errors="replace") if isinstance(e.stdout, bytes) else (e.stdout or ""),
            stderr=(e.stderr or b"").decode("utf-8", errors="replace") if isinstance(e.stderr, bytes) else (e.stderr or ""),
            artifacts=[],
            extra={"timeout_seconds": timeout_seconds},
        )

    outcome = "passed" if result.returncode == 0 else "failed"
    return EndStateResult(
        task_id=task_dir.name,
        outcome=outcome,
        summary=("PASS" if outcome == "passed" else "FAIL"),
        stdout=result.stdout,
        stderr=result.stderr,
        artifacts=[],
        extra={"exit_code": result.returncode},
    )


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: end_state.py <task_dir>", file=sys.stderr)
        return 2
    task_dir = pathlib.Path(sys.argv[1])
    result = grade_end_state(task_dir)
    print(json.dumps(result.to_dict(), indent=2))
    return 0 if result.passed else 1


if __name__ == "__main__":
    sys.exit(main())

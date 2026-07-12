"""SPEC §41.5 / §41.11 end-state graders.

End-state graders inspect the *final* workspace revision after a run
completes: file contents, test results, diff against baseline. They do
**not** see the model's intermediate steps (that's the trajectory's job)
and they do **not** see the model's reasoning.

**Hidden-test isolation (SPEC §41.5, §41.11):** grader code is *never*
projected into model context. The grader modules here are imported by the
runner only *after* the run completes; the model has no way to read them.
"""

from __future__ import annotations

import hashlib
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from ..run_record import GraderResult

__all__ = [
    "DiffGrader",
    "EndStateGraderInput",
    "FileContainsGrader",
    "HiddenTestGrader",
    "NoopGrader",
    "PassFailGrader",
    "ScriptGrader",
    "TestRunGrader",
    "WorkspaceSnapshot",
]


@dataclass(frozen=True)
class WorkspaceSnapshot:
    """A snapshot of the workspace at the end of a run.

    ``final_revision`` is the git commit hash of the agent's final state.
    ``workdir`` is the working directory containing the agent's files.
    ``baseline_revision`` is the starting commit (for diff computation).
    """

    workdir: Path
    final_revision: str
    baseline_revision: str
    extra: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class EndStateGraderInput:
    """Everything an end-state grader needs to make a decision.

    Includes the workspace snapshot, the task contract (objective, acceptance
    criteria), and an optional artifact fetcher (for reading CAS-stored
    tool results without going through the kernel).
    """

    snapshot: WorkspaceSnapshot
    objective: str
    acceptance_criteria: list[str]
    risk_class: str = "normal"
    artifact_fetcher: Callable[[str], bytes] | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


class EndStateGrader:
    """Base class for end-state graders.

    Subclasses implement :meth:`grade` and return a :class:`GraderResult`.
    """

    grader_id: str = "end_state.base"
    grader_version: str = "0.1.0"

    def grade(self, inp: EndStateGraderInput) -> GraderResult:
        """Grade the run. Subclasses must override."""
        raise NotImplementedError


class NoopGrader(EndStateGrader):
    """A trivial grader that always passes with score 1.0. For tests."""

    grader_id = "end_state.noop"
    grader_version = "0.1.0"

    def grade(self, inp: EndStateGraderInput) -> GraderResult:
        return GraderResult(
            grader_id=self.grader_id,
            grader_version=self.grader_version,
            passed=True,
            score=1.0,
            evidence=["noop grader always passes"],
        )


class PassFailGrader(EndStateGrader):
    """A grader whose pass/fail is decided by a predicate function."""

    grader_id = "end_state.pass_fail"
    grader_version = "0.1.0"

    def __init__(self, predicate: Callable[[EndStateGraderInput], tuple[bool, float, list[str]]]) -> None:
        self.predicate: Callable[[EndStateGraderInput], tuple[bool, float, list[str]]] = predicate

    def grade(self, inp: EndStateGraderInput) -> GraderResult:
        passed, score, evidence = self.predicate(inp)
        return GraderResult(
            grader_id=self.grader_id,
            grader_version=self.grader_version,
            passed=passed,
            score=max(0.0, min(1.0, score)),
            evidence=evidence,
        )


class FileContainsGrader(EndStateGrader):
    """Pass iff a target file contains all required substrings.

    ``path`` is relative to the workspace workdir. ``required_substrings``
    is a list of strings that must all be present. ``forbidden_substrings``
    is a list of strings that must all be absent.
    """

    grader_id = "end_state.file_contains"
    grader_version = "0.1.0"

    def __init__(
        self,
        path: str,
        required_substrings: list[str] | None = None,
        forbidden_substrings: list[str] | None = None,
    ) -> None:
        self.path: str = path
        self.required: list[str] = list(required_substrings or [])
        self.forbidden: list[str] = list(forbidden_substrings or [])

    def grade(self, inp: EndStateGraderInput) -> GraderResult:
        target = inp.snapshot.workdir / self.path
        if not target.exists():
            return GraderResult(
                grader_id=self.grader_id,
                grader_version=self.grader_version,
                passed=False,
                score=0.0,
                evidence=[f"file not found: {self.path}"],
            )
        text = target.read_text(encoding="utf-8", errors="replace")
        evidence: list[str] = []
        passed = True
        for sub in self.required:
            if sub in text:
                evidence.append(f"found required substring ({len(sub)} chars)")
            else:
                evidence.append(f"MISSING required substring: {sub!r}")
                passed = False
        for sub in self.forbidden:
            if sub in text:
                evidence.append(f"FORBIDDEN substring present: {sub!r}")
                passed = False
            else:
                evidence.append(f"forbidden substring absent: {sub!r}")
        score = 1.0 if passed else 0.0
        # Partial credit if some required substrings are present.
        if self.required and not passed:
            found = sum(1 for sub in self.required if sub in text)
            score = found / len(self.required)
        return GraderResult(
            grader_id=self.grader_id,
            grader_version=self.grader_version,
            passed=passed,
            score=score,
            evidence=evidence,
        )


class DiffGrader(EndStateGrader):
    """Inspect the diff between baseline and final revisions.

    The grader counts added/removed lines and decides pass/fail based on
    a maximum allowed diff size and an optional list of paths that *must*
    be modified.
    """

    grader_id = "end_state.diff"
    grader_version = "0.1.0"

    def __init__(
        self,
        max_added_lines: int = 500,
        max_removed_lines: int = 500,
        must_modify_paths: list[str] | None = None,
    ) -> None:
        self.max_added: int = max_added_lines
        self.max_removed: int = max_removed_lines
        self.must_modify: list[str] = list(must_modify_paths or [])

    def grade(self, inp: EndStateGraderInput) -> GraderResult:
        added, removed, modified_paths = _compute_diff_stats(
            inp.snapshot.workdir,
            inp.snapshot.baseline_revision,
            inp.snapshot.final_revision,
        )
        evidence: list[str] = [
            f"added={added} removed={removed}",
            f"modified_paths={modified_paths or '(none)'}",
        ]
        passed = True
        if added > self.max_added:
            evidence.append(f"FAIL: added {added} > max {self.max_added}")
            passed = False
        if removed > self.max_removed:
            evidence.append(f"FAIL: removed {removed} > max {self.max_removed}")
            passed = False
        for must in self.must_modify:
            if must not in modified_paths:
                evidence.append(f"FAIL: required modification missing: {must}")
                passed = False
        score = 1.0 if passed else 0.5
        return GraderResult(
            grader_id=self.grader_id,
            grader_version=self.grader_version,
            passed=passed,
            score=score,
            evidence=evidence,
        )


class TestRunGrader(EndStateGrader):
    """Run a test command in the workspace and parse the result.

    The command is run via ``subprocess.run`` with a timeout. A passing run
    has exit code 0. ``parser`` may be supplied to extract partial-credit
    scores from the test runner's stdout (e.g. "30 passed, 2 failed" → 0.94).
    """

    grader_id = "end_state.test_run"
    grader_version = "0.1.0"

    def __init__(
        self,
        command: list[str],
        timeout_seconds: int = 300,
        parser: Callable[[str, int], tuple[float, list[str]]] | None = None,
    ) -> None:
        self.command: list[str] = list(command)
        self.timeout: int = timeout_seconds
        self.parser: Callable[[str, int], tuple[float, list[str]]] | None = parser

    def grade(self, inp: EndStateGraderInput) -> GraderResult:
        try:
            proc = subprocess.run(
                self.command,
                cwd=str(inp.snapshot.workdir),
                capture_output=True,
                text=True,
                timeout=self.timeout,
                check=False,
            )
        except TimeoutError:
            return GraderResult(
                grader_id=self.grader_id,
                grader_version=self.grader_version,
                passed=False,
                score=0.0,
                evidence=[f"timeout after {self.timeout}s"],
            )
        except FileNotFoundError as exc:
            return GraderResult(
                grader_id=self.grader_id,
                grader_version=self.grader_version,
                passed=False,
                score=0.0,
                evidence=[f"command not found: {exc}"],
            )
        stdout = proc.stdout
        rc = proc.returncode
        if self.parser is not None:
            score, evidence = self.parser(stdout, rc)
        else:
            score = 1.0 if rc == 0 else 0.0
            evidence = [f"exit_code={rc}"]
            if rc != 0:
                # Include last 200 chars of stdout for triage.
                evidence.append("tail=" + stdout[-200:])
        return GraderResult(
            grader_id=self.grader_id,
            grader_version=self.grader_version,
            passed=rc == 0,
            score=max(0.0, min(1.0, score)),
            evidence=evidence,
            metadata={"exit_code": rc, "stdout_sha256": _sha256_text(stdout)},
        )


class HiddenTestGrader(EndStateGrader):
    """Run the hidden tests from the task package.

    Hidden tests live in ``evals/tasks/<suite>/<task>/hidden/`` (SPEC §41.4)
    and are *never* projected into model context. This grader copies them
    into the workspace's hidden-test directory (which the agent should not
    be able to read), runs them, and reports pass/fail.

    Implementation note: in this offline eval lab, the grader simply invokes
    a runner script. In production, hidden tests are run inside a sandbox
    with the agent's process killed and its policy revoked, so even a
    malicious agent cannot read them mid-run.
    """

    grader_id = "end_state.hidden_tests"
    grader_version = "0.1.0"

    def __init__(self, hidden_dir: Path, command: list[str], timeout_seconds: int = 300) -> None:
        self.hidden_dir: Path = hidden_dir
        self.command: list[str] = list(command)
        self.timeout: int = timeout_seconds

    def grade(self, inp: EndStateGraderInput) -> GraderResult:
        if not self.hidden_dir.exists():
            return GraderResult(
                grader_id=self.grader_id,
                grader_version=self.grader_version,
                passed=False,
                score=0.0,
                evidence=[f"hidden dir not found: {self.hidden_dir}"],
            )
        try:
            proc = subprocess.run(
                self.command,
                cwd=str(inp.snapshot.workdir),
                capture_output=True,
                text=True,
                timeout=self.timeout,
                env={"HIDDEN_DIR": str(self.hidden_dir), "PATH": "/usr/bin:/bin"},
                check=False,
            )
        except TimeoutError:
            return GraderResult(
                grader_id=self.grader_id,
                grader_version=self.grader_version,
                passed=False,
                score=0.0,
                evidence=[f"timeout after {self.timeout}s"],
            )
        except FileNotFoundError as exc:
            return GraderResult(
                grader_id=self.grader_id,
                grader_version=self.grader_version,
                passed=False,
                score=0.0,
                evidence=[f"command not found: {exc}"],
            )
        rc = proc.returncode
        return GraderResult(
            grader_id=self.grader_id,
            grader_version=self.grader_version,
            passed=rc == 0,
            score=1.0 if rc == 0 else 0.0,
            evidence=[f"exit_code={rc}", "tail=" + proc.stdout[-200:]],
            metadata={"exit_code": rc, "stdout_sha256": _sha256_text(proc.stdout)},
        )


class ScriptGrader(EndStateGrader):
    """Run an external grader script (e.g. Python, bash) that returns JSON.

    The script receives the workspace path and task metadata as JSON on
    stdin and writes a JSON object on stdout with keys ``passed``, ``score``,
    ``evidence`` (list of strings), ``metadata`` (dict).
    """

    grader_id = "end_state.script"
    grader_version = "0.1.0"

    def __init__(self, script: list[str], timeout_seconds: int = 600) -> None:
        self.script: list[str] = list(script)
        self.timeout: int = timeout_seconds

    def grade(self, inp: EndStateGraderInput) -> GraderResult:
        import json

        payload = {
            "workdir": str(inp.snapshot.workdir),
            "final_revision": inp.snapshot.final_revision,
            "baseline_revision": inp.snapshot.baseline_revision,
            "objective": inp.objective,
            "acceptance_criteria": list(inp.acceptance_criteria),
            "risk_class": inp.risk_class,
            "metadata": dict(inp.metadata),
        }
        try:
            proc = subprocess.run(
                self.script,
                input=json.dumps(payload),
                capture_output=True,
                text=True,
                timeout=self.timeout,
                check=False,
            )
        except TimeoutError:
            return GraderResult(
                grader_id=self.grader_id,
                grader_version=self.grader_version,
                passed=False,
                score=0.0,
                evidence=[f"timeout after {self.timeout}s"],
            )
        except FileNotFoundError as exc:
            return GraderResult(
                grader_id=self.grader_id,
                grader_version=self.grader_version,
                passed=False,
                score=0.0,
                evidence=[f"command not found: {exc}"],
            )
        if proc.returncode != 0:
            return GraderResult(
                grader_id=self.grader_id,
                grader_version=self.grader_version,
                passed=False,
                score=0.0,
                evidence=[f"exit_code={proc.returncode}", "stderr=" + proc.stderr[-200:]],
            )
        try:
            out = json.loads(proc.stdout)
        except json.JSONDecodeError as exc:
            return GraderResult(
                grader_id=self.grader_id,
                grader_version=self.grader_version,
                passed=False,
                score=0.0,
                evidence=[f"invalid JSON: {exc}", "stdout=" + proc.stdout[-200:]],
            )
        return GraderResult(
            grader_id=self.grader_id,
            grader_version=self.grader_version,
            passed=bool(out.get("passed", False)),
            score=float(out.get("score", 0.0)),
            evidence=list(out.get("evidence", []) or []),
            metadata=dict(out.get("metadata", {}) or {}),
        )


# ──────────────────────────── helpers ─────────────────────────────────────


def _sha256_text(s: str) -> str:
    return "sha256:" + hashlib.sha256(s.encode("utf-8")).hexdigest()


def _compute_diff_stats(
    workdir: Path, baseline: str, final: str
) -> tuple[int, int, list[str]]:
    """Compute added/removed line counts and modified path list.

    Falls back to (0, 0, []) if git is unavailable or the revisions don't
    exist. We never raise — graders must be robust to malformed workspaces.
    """
    if not baseline or not final or baseline == final:
        return 0, 0, []
    try:
        proc = subprocess.run(
            ["git", "diff", "--numstat", f"{baseline}..{final}"],
            cwd=str(workdir),
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except (FileNotFoundError, TimeoutError):
        return 0, 0, []
    if proc.returncode != 0:
        return 0, 0, []
    added = 0
    removed = 0
    modified: list[str] = []
    for line in proc.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        a, r, path = parts[0], parts[1], parts[2]
        try:
            added += int(a) if a != "-" else 0
            removed += int(r) if r != "-" else 0
        except ValueError:
            continue
        modified.append(path)
    return added, removed, modified


def parse_pytest_summary(stdout: str, exit_code: int) -> tuple[float, list[str]]:
    """Parse a pytest summary line into (score, evidence).

    Looks for ``N passed``, ``N failed``, ``N errors``. Score is
    ``passed / (passed + failed + errors)``.
    """
    import re

    passed = 0
    failed = 0
    errors = 0
    skipped = 0
    for m in re.finditer(r"(\d+) (passed|failed|error|skipped)", stdout):
        n, kind = int(m.group(1)), m.group(2)
        if kind == "passed":
            passed = n
        elif kind == "failed":
            failed = n
        elif kind == "error":
            errors = n
        elif kind == "skipped":
            skipped = n
    denom = passed + failed + errors
    score = 1.0 if denom == 0 and exit_code == 0 else (passed / denom if denom > 0 else 0.0)
    evidence = [f"passed={passed} failed={failed} errors={errors} skipped={skipped}"]
    return score, evidence

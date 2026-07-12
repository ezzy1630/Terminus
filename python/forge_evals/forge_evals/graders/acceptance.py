"""SPEC §41.4 / §41.5 acceptance graders.

Maps a task's *acceptance criteria* (the human-authored list in the task
contract) to pass/fail with structured evidence. Each criterion is evaluated
by a small predicate over the post-run workspace.

Acceptance graders sit between end-state graders (which inspect raw file
state) and security graders (which verify no policy violation occurred).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

from ..run_record import GraderResult
from .end_state import EndStateGrader, EndStateGraderInput

__all__ = [
    "AcceptanceCriterion",
    "AcceptanceGrader",
    "CriterionPredicate",
    "CriterionResult",
    "criterion_file_contains",
    "criterion_file_exists",
    "criterion_test_command",
]


@dataclass(frozen=True)
class CriterionResult:
    """A single criterion's evaluation result."""

    criterion_id: str
    description: str
    passed: bool
    evidence: list[str] = field(default_factory=list)


CriterionPredicate = Callable[[EndStateGraderInput], CriterionResult]


@dataclass(frozen=True)
class AcceptanceCriterion:
    """A single acceptance criterion from the task contract.

    ``criterion_id`` is a stable slug (e.g. ``"fix-off-by-one"``); the grader
    result references it so that promotion-gate evidence can be traced back
    to the originating criterion.
    """

    criterion_id: str
    description: str
    predicate: CriterionPredicate


class AcceptanceGrader(EndStateGrader):
    """Grade a run by evaluating each acceptance criterion.

    Score is the fraction of criteria that pass. Pass iff all pass.
    """

    grader_id = "acceptance.criteria"
    grader_version = "0.1.0"

    def __init__(self, criteria: list[AcceptanceCriterion]) -> None:
        self.criteria: list[AcceptanceCriterion] = list(criteria)

    def grade(self, inp: EndStateGraderInput) -> GraderResult:
        results: list[CriterionResult] = []
        for c in self.criteria:
            results.append(c.predicate(inp))
        passed_count = sum(1 for r in results if r.passed)
        total = len(results) or 1
        score = passed_count / total
        passed = all(r.passed for r in results) if results else False
        evidence: list[str] = []
        for r in results:
            mark = "PASS" if r.passed else "FAIL"
            evidence.append(f"[{mark}] {r.criterion_id}: {r.description}")
            for e in r.evidence:
                evidence.append(f"    - {e}")
        return GraderResult(
            grader_id=self.grader_id,
            grader_version=self.grader_version,
            passed=passed,
            score=score,
            evidence=evidence,
            metadata={
                "criterion_results": [
                    {
                        "criterion_id": r.criterion_id,
                        "description": r.description,
                        "passed": r.passed,
                    }
                    for r in results
                ]
            },
        )


# ──────────────────────────── built-in predicates ────────────────────────


def criterion_file_exists(criterion_id: str, description: str, path: str) -> AcceptanceCriterion:
    """Build a criterion that passes iff ``path`` exists in the workspace."""

    def _pred(inp: EndStateGraderInput) -> CriterionResult:
        target = inp.snapshot.workdir / path
        ok = target.exists()
        return CriterionResult(
            criterion_id=criterion_id,
            description=description,
            passed=ok,
            evidence=[f"{path} exists={ok}"],
        )

    return AcceptanceCriterion(criterion_id, description, _pred)


def criterion_file_contains(
    criterion_id: str,
    description: str,
    path: str,
    required: list[str] | None = None,
    forbidden: list[str] | None = None,
) -> AcceptanceCriterion:
    """Build a criterion that passes iff ``path`` contains all ``required`` and no ``forbidden``."""

    def _pred(inp: EndStateGraderInput) -> CriterionResult:
        target = inp.snapshot.workdir / path
        if not target.exists():
            return CriterionResult(
                criterion_id=criterion_id,
                description=description,
                passed=False,
                evidence=[f"file not found: {path}"],
            )
        text = target.read_text(encoding="utf-8", errors="replace")
        ev: list[str] = []
        ok = True
        for sub in required or []:
            if sub in text:
                ev.append(f"found required: {sub!r}")
            else:
                ev.append(f"MISSING required: {sub!r}")
                ok = False
        for sub in forbidden or []:
            if sub in text:
                ev.append(f"FORBIDDEN present: {sub!r}")
                ok = False
            else:
                ev.append(f"forbidden absent: {sub!r}")
        return CriterionResult(criterion_id, description, passed=ok, evidence=ev)

    return AcceptanceCriterion(criterion_id, description, _pred)


def criterion_test_command(
    criterion_id: str,
    description: str,
    command: list[str],
    timeout_seconds: int = 120,
) -> AcceptanceCriterion:
    """Build a criterion that runs a command and passes iff exit code is 0."""

    def _pred(inp: EndStateGraderInput) -> CriterionResult:
        import subprocess

        try:
            proc = subprocess.run(
                command,
                cwd=str(inp.snapshot.workdir),
                capture_output=True,
                text=True,
                timeout=timeout_seconds,
                check=False,
            )
        except TimeoutError:
            return CriterionResult(
                criterion_id=criterion_id,
                description=description,
                passed=False,
                evidence=[f"timeout after {timeout_seconds}s"],
            )
        except FileNotFoundError as exc:
            return CriterionResult(
                criterion_id=criterion_id,
                description=description,
                passed=False,
                evidence=[f"command not found: {exc}"],
            )
        return CriterionResult(
            criterion_id=criterion_id,
            description=description,
            passed=proc.returncode == 0,
            evidence=[f"exit_code={proc.returncode}", "tail=" + proc.stdout[-200:]],
        )

    return AcceptanceCriterion(criterion_id, description, _pred)

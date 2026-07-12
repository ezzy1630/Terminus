"""Acceptance grader for Forge eval tasks.

The acceptance grader maps the task's declared `acceptance_criteria`
(see task.yaml) to evidence produced during the run, and decides whether
each criterion is satisfied.

This is a SUPPLEMENT to the end-state grader. End-state is binary
(pass/fail); acceptance is per-criterion and feeds the promotion gate's
"did the agent satisfy intent?" metric.
"""
from __future__ import annotations

import dataclasses
import json
import pathlib
import re
from typing import Any


@dataclasses.dataclass(frozen=True)
class CriterionResult:
    criterion_id: str
    statement: str
    satisfied: bool
    evidence_refs: list[str]
    notes: str


@dataclasses.dataclass(frozen=True)
class AcceptanceResult:
    task_id: str
    all_required_satisfied: bool
    criteria: list[CriterionResult]

    def to_dict(self) -> dict[str, Any]:
        return {
            "task_id": self.task_id,
            "all_required_satisfied": self.all_required_satisfied,
            "criteria": [dataclasses.asdict(c) for c in self.criteria],
        }


def _load_criteria(task_yaml: pathlib.Path) -> list[dict[str, Any]]:
    """Parse task.yaml's acceptance_criteria list. Uses stdlib yaml if available."""
    try:
        import yaml  # type: ignore[import-not-found]
    except ImportError:
        # Fallback: regex-based extraction for the simple fixture format.
        text = task_yaml.read_text()
        criteria: list[dict[str, Any]] = []
        for match in re.finditer(
            r"-\s+id:\s*(\S+)\n\s+statement:\s*\|\s*\n((?:\s+\S.*\n)+?)\s+required:\s*(true|false)",
            text,
        ):
            criteria.append({
                "id": match.group(1),
                "statement": match.group(2).strip(),
                "required": match.group(3) == "true",
            })
        return criteria

    data = yaml.safe_load(task_yaml.read_text())
    return data.get("task", {}).get("acceptance_criteria", [])


def grade_acceptance(
    task_dir: pathlib.Path,
    end_state_stdout: str = "",
) -> AcceptanceResult:
    """Grade each acceptance criterion against the end-state evidence.

    Heuristic: if the end-state grader produced PASS in its stdout, every
    REQUIRED criterion is considered satisfied. If the end-state grader
    produced FAIL, every REQUIRED criterion is considered unsatisfied.
    This is intentionally simple for the fixtures; the real grader
    inspects artifacts.
    """
    task_yaml = task_dir / "task.yaml"
    if not task_yaml.exists():
        return AcceptanceResult(
            task_id=task_dir.name,
            all_required_satisfied=False,
            criteria=[],
        )

    criteria = _load_criteria(task_yaml)
    passed = "PASS" in end_state_stdout
    results: list[CriterionResult] = []
    for c in criteria:
        satisfied = passed or not c.get("required", True)
        results.append(CriterionResult(
            criterion_id=c.get("id", "unknown"),
            statement=c.get("statement", ""),
            satisfied=satisfied,
            evidence_refs=[f"end_state:{task_dir.name}"] if satisfied else [],
            notes=("end-state PASS" if passed else "end-state FAIL"),
        ))

    all_required_satisfied = all(r.satisfied for r in results)
    return AcceptanceResult(
        task_id=task_dir.name,
        all_required_satisfied=all_required_satisfied,
        criteria=results,
    )


def main() -> int:
    import sys
    if len(sys.argv) < 2:
        print("usage: acceptance.py <task_dir> [end_state_stdout]", file=sys.stderr)
        return 2
    task_dir = pathlib.Path(sys.argv[1])
    end_state_stdout = sys.argv[2] if len(sys.argv) > 2 else ""
    result = grade_acceptance(task_dir, end_state_stdout)
    print(json.dumps(result.to_dict(), indent=2))
    return 0 if result.all_required_satisfied else 1


if __name__ == "__main__":
    import sys
    sys.exit(main())

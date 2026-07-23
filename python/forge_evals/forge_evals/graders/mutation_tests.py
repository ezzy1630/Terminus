"""SPEC §41.5 / audit requirement: Grader mutation testing.

Proves that graders are non-trivial and reliably catch intentionally broken
patches/code changes (mutants).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from ..run_record import GraderResult
from .end_state import EndStateGrader, EndStateGraderInput

__all__ = [
    "MutantResult",
    "MutationOperator",
    "MutationTestReport",
    "mutate_code",
    "run_grader_mutation_suite",
]


class MutationOperator:
    """Supported code mutation operators."""

    SYNTAX_ERROR = "syntax_error"
    LOGIC_INVERSION = "logic_inversion"
    OFF_BY_ONE = "off_by_one"
    DELETED_RETURN = "deleted_return"
    NULL_POINTER = "null_pointer"
    PARTIAL_FILE_EDIT = "partial_file_edit"


@dataclass(frozen=True)
class MutantResult:
    """Result of running a grader against a single mutated patch/code sample."""

    operator: str
    original_code: str
    mutated_code: str
    grader_passed: bool
    grader_score: float
    caught: bool  # True iff grader rejected the mutant (passed=False or score < 1.0)
    evidence: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class MutationTestReport:
    """Report summarizing grader mutation test results."""

    grader_id: str
    total_mutants: int
    caught_mutants: int
    uncaught_mutants: int
    mutation_score: float  # caught_mutants / total_mutants
    mutant_results: list[MutantResult] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        """Grader passes mutation test if 100% of non-trivial mutants are caught."""
        return self.total_mutants > 0 and self.caught_mutants == self.total_mutants


def mutate_code(code: str, operator: str) -> str:
    """Apply a mutation operator to code string.
    
    If the operator cannot be applied, returns an altered fallback string.
    """
    if operator == MutationOperator.SYNTAX_ERROR:
        return "def mutated_broken_syntax(:\n    return INVALID SYNTAX HERE"

    if operator == MutationOperator.LOGIC_INVERSION:
        res = code
        if "==" in res:
            res = res.replace("==", "!=")
        elif "!=" in res:
            res = res.replace("!=", "==")
        elif "True" in res:
            res = res.replace("True", "False")
        elif "False" in res:
            res = res.replace("False", "True")
        else:
            res = res + "\n# mutated logic inversion\n_MUTATED_FLAG = False\n"
        return res

    if operator == MutationOperator.OFF_BY_ONE:
        if "+ 1" in code:
            return code.replace("+ 1", "- 1")
        if "- 1" in code:
            return code.replace("- 1", "+ 1")
        return re.sub(r"\b(\d+)\b", lambda m: str(int(m.group(1)) + 1), code, count=1)

    if operator == MutationOperator.DELETED_RETURN:
        lines = code.splitlines()
        filtered = [line_item for line_item in lines if not line_item.strip().startswith("return ")]
        if len(filtered) == len(lines):
            filtered.append("    return None  # mutated deleted return")
        return "\n".join(filtered)

    if operator == MutationOperator.NULL_POINTER:
        return "None.invalid_attribute_dereference()  # null pointer mutant\n" + code

    if operator == MutationOperator.PARTIAL_FILE_EDIT:
        lines = code.splitlines()
        return "\n".join(lines[: len(lines) // 2]) if len(lines) > 1 else "# truncated"

    raise ValueError(f"Unknown mutation operator: {operator}")


def run_grader_mutation_suite(
    grader: EndStateGrader,
    base_input: EndStateGraderInput,
    sample_code: str,
    target_file: str = "solution.py",
    operators: tuple[str, ...] = (
        MutationOperator.SYNTAX_ERROR,
        MutationOperator.LOGIC_INVERSION,
        MutationOperator.OFF_BY_ONE,
        MutationOperator.DELETED_RETURN,
        MutationOperator.NULL_POINTER,
        MutationOperator.PARTIAL_FILE_EDIT,
    ),
) -> MutationTestReport:
    """Apply mutation operators to sample_code and test grader's fault-detection capabilities."""
    mutant_results: list[MutantResult] = []
    caught_count = 0

    target_path = base_input.snapshot.workdir / target_file

    for op in operators:
        mutated = mutate_code(sample_code, op)
        # Write mutated code to target file in workspace
        target_path.write_text(mutated, encoding="utf-8")

        meta = dict(base_input.metadata)
        meta["mutated_code"] = mutated
        meta["mutation_operator"] = op

        mutated_input = EndStateGraderInput(
            snapshot=base_input.snapshot,
            objective=base_input.objective,
            acceptance_criteria=base_input.acceptance_criteria,
            risk_class=base_input.risk_class,
            metadata=meta,
        )

        try:
            res = grader.grade(mutated_input)
            # A mutant is caught if the grader fails or score is less than 1.0
            caught = (not res.passed) or (res.score < 1.0)
            evidence = list(res.evidence)
        except Exception as exc:
            caught = True
            evidence = [f"Grader threw exception on mutant: {type(exc).__name__}: {exc}"]
            res = GraderResult(
                grader_id=getattr(grader, "grader_id", "unknown"),
                grader_version=getattr(grader, "grader_version", "0.0.0"),
                passed=False,
                score=0.0,
                evidence=evidence,
            )

        if caught:
            caught_count += 1

        mutant_results.append(
            MutantResult(
                operator=op,
                original_code=sample_code,
                mutated_code=mutated,
                grader_passed=res.passed,
                grader_score=res.score,
                caught=caught,
                evidence=evidence,
            )
        )

    total = len(operators)
    score = caught_count / total if total > 0 else 0.0
    return MutationTestReport(
        grader_id=getattr(grader, "grader_id", "unknown"),
        total_mutants=total,
        caught_mutants=caught_count,
        uncaught_mutants=total - caught_count,
        mutation_score=score,
        mutant_results=mutant_results,
    )

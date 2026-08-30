"""Mutation-based grader for the parser test-generation task."""

from __future__ import annotations

import ast
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

MUTANTS = (
    "def parse_tokens(text: str) -> list[str]:\n    return [] if text == '' else text.split()\n",
    "def parse_tokens(text: str) -> list[str]:\n    return text.split(' ')\n",
    "def parse_tokens(text: str) -> list[str]:\n    return text.split()[1:]\n",
    "def parse_tokens(text: str) -> list[str]:\n    return text.splitlines()\n",
    "def parse_tokens(text: str) -> list[str]:\n    return text.encode('ascii', 'ignore').decode().split()\n",
)


def _pytest(cwd: Path, target: str) -> tuple[bool, str]:
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", target],
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    return result.returncode == 0, (result.stdout + result.stderr).strip()[-800:]


def _has_real_tests(test_file: Path) -> bool:
    try:
        tree = ast.parse(test_file.read_text(encoding="utf-8"))
    except (OSError, SyntaxError):
        return False
    functions = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))]
    return len(functions) >= 5 and any(
        isinstance(node, ast.ImportFrom)
        and node.module == "src.parser"
        and any(alias.name == "parse_tokens" for alias in node.names)
        for node in tree.body
    )


def main() -> int:
    payload = json.load(sys.stdin)
    workdir = Path(payload["workdir"]).resolve()
    submitted = workdir / "tests" / "test_parser.py"
    checks: list[tuple[str, bool, str]] = []
    checks.append(("submitted test module is substantive", submitted.is_file() and _has_real_tests(submitted), ""))
    baseline_ok, baseline_output = _pytest(workdir, "tests/test_parser.py") if submitted.is_file() else (False, "missing")
    checks.append(("submitted tests pass", baseline_ok, baseline_output))
    killed = 0
    mutant_details: list[str] = []
    if submitted.is_file() and checks[0][1]:
        with tempfile.TemporaryDirectory(prefix="forge-testgen-") as temp:
            root = Path(temp)
            shutil.copytree(workdir / "src", root / "src")
            (root / "tests").mkdir()
            shutil.copy2(submitted, root / "tests" / "test_parser.py")
            parser = root / "src" / "parser.py"
            original = parser.read_text(encoding="utf-8")
            for index, mutant in enumerate(MUTANTS, start=1):
                parser.write_text(mutant, encoding="utf-8")
                passed, detail = _pytest(root, "tests/test_parser.py")
                if not passed:
                    killed += 1
                mutant_details.append(f"mutant {index}: {'SURVIVED' if passed else 'KILLED'} {detail}")
                parser.write_text(original, encoding="utf-8")
    checks.append(("tests kill at least four independent parser mutations", killed >= 4, "; ".join(mutant_details)))
    passed_count = sum(ok for _, ok, _ in checks)
    evidence = [f"passed {passed_count}/{len(checks)} behavioral checks", *[f"{name}: {'PASS' if ok else 'FAIL'} {detail}" for name, ok, detail in checks]]
    result = {"passed": passed_count == len(checks), "score": passed_count / len(checks), "evidence": evidence, "metadata": {"checks_total": len(checks), "checks_passed": passed_count, "mutants_killed": killed, "mutants_total": len(MUTANTS)}}
    print(json.dumps(result))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

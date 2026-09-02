"""Deterministic grader for canary/test-repair-001 (failing-test repair).

Success = full suite (public + staged hidden cases) passes with the tests/
directory untouched. Repairing tests by editing them fails the scope check.
Repository-state and test-based only; no LLM judge on the success path.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


def _run(workdir: Path, *args: str) -> tuple[bool, str]:
    result = subprocess.run(
        [sys.executable, *args],
        cwd=workdir,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    output = (result.stdout + result.stderr).strip()
    return result.returncode == 0, output[-1_000:]


def _changed_files(workdir: Path) -> set[str]:
    result = subprocess.run(  # skipcq: BAN-B607
        ["git", "status", "--porcelain"],
        cwd=workdir,
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    return {
        line[3:].strip()
        for line in result.stdout.splitlines()
        if len(line) >= 3 and not line[3:].strip().startswith("hidden/")
    }


def main() -> int:
    payload = json.load(sys.stdin)
    workdir = Path(payload["workdir"]).resolve()
    checks: list[tuple[str, bool, str]] = []

    tests_ok, tests_output = _run(workdir, "-m", "pytest", "-q")
    checks.append(("full test suite passes", tests_ok, tests_output))
    changed = _changed_files(workdir)
    scope_ok = bool(changed) and changed <= {"src/textops.py"}
    checks.append(
        ("only src/textops.py changed; tests untouched", scope_ok, str(sorted(changed)))
    )

    passed = sum(ok for _, ok, _ in checks)
    result = {
        "passed": passed == len(checks),
        "score": passed / len(checks),
        "evidence": [f"{name}: {'PASS' if ok else 'FAIL'} {detail}" for name, ok, detail in checks],
        "metadata": {"checks_total": len(checks), "checks_passed": passed},
    }
    print(json.dumps(result))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

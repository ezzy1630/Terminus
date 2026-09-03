"""Deterministic grader for retrieval-v1/retrieval-named-02.

Verifies:
1. Public tests pass (returncode == 0)
2. Hidden edge-case tests pass (returncode == 0)
3. Only src/ledger.py changed (git status --porcelain)
Does not check for "PASS" in stdout.
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
    result = subprocess.run(
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

    # 1. Run public tests
    pub_ok, pub_out = _run(workdir, "-m", "pytest", "-q", "tests")
    checks.append(("public tests pass", pub_ok, pub_out))

    # 2. Run hidden tests if present
    hidden_test = workdir / "hidden" / "test_hidden.py"
    if hidden_test.exists():
        hidden_ok, hidden_out = _run(workdir, "-m", "pytest", "-q", str(hidden_test))
        checks.append(("hidden edge-case tests pass", hidden_ok, hidden_out))
    else:
        checks.append(("hidden edge-case tests pass", False, "hidden test file missing"))

    # 3. Scope verification: only src/ledger.py changed
    changed = _changed_files(workdir)
    scope_ok = changed == {"src/ledger.py"}
    checks.append(("only src/ledger.py changed", scope_ok, str(sorted(changed))))

    passed = sum(ok for _, ok, _ in checks)
    all_passed = passed == len(checks)
    result = {
        "passed": all_passed,
        "score": passed / len(checks),
        "evidence": [f"{name}: {'OK' if ok else 'FAIL'} {detail}" for name, ok, detail in checks],
        "metadata": {"checks_total": len(checks), "checks_passed": passed},
    }
    print(json.dumps(result))
    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main())

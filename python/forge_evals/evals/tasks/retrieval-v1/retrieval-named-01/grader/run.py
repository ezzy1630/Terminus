"""Deterministic grader for retrieval-v1/retrieval-named-01.

Verifies:
1. Hidden boundary tests pass (run first to prevent tampering)
2. Public tests pass (returncode == 0)
3. Only src/shipping.py changed (checks git status and commit diff)
Does not check for "PASS" in stdout.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path


def _run(workdir: Path, *args: str) -> tuple[bool, str]:
    result = subprocess.run(
        [sys.executable, *args],
        cwd=workdir,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    output = (result.stdout + result.stderr).strip()
    return result.returncode == 0, output[-1_000:]


def _changed_files(workdir: Path) -> set[str]:
    git_bin = shutil.which("git") or "git"
    # Check working tree (uncommitted/staged)
    status_proc = subprocess.run(
        [git_bin, "status", "--porcelain"],
        cwd=workdir,
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    status_files = {
        line[3:].strip()
        for line in status_proc.stdout.splitlines()
        if len(line) >= 3 and not line[3:].strip().startswith("hidden/")
    }

    # Check committed changes against initial/base commit
    log_proc = subprocess.run(
        [git_bin, "log", "--reverse", "--format=%H"],
        cwd=workdir,
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    commits = [line.strip() for line in log_proc.stdout.splitlines() if line.strip()]
    diff_files: set[str] = set()
    if commits:
        base_commit = commits[0]
        diff_proc = subprocess.run(
            [git_bin, "diff", "--name-only", base_commit, "HEAD"],
            cwd=workdir,
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
        diff_files = {
            line.strip()
            for line in diff_proc.stdout.splitlines()
            if line.strip() and not line.strip().startswith("hidden/")
        }

    return status_files | diff_files


def main() -> int:
    payload = json.load(sys.stdin)
    workdir = Path(payload["workdir"]).resolve()
    checks: list[tuple[str, bool, str]] = []

    # 1. Run hidden tests first to prevent candidate code tampering
    hidden_test = workdir / "hidden" / "test_hidden.py"
    if hidden_test.exists():
        hidden_ok, hidden_out = _run(workdir, "-m", "pytest", "-q", str(hidden_test))
        checks.append(("hidden boundary tests pass", hidden_ok, hidden_out))
    else:
        checks.append(("hidden boundary tests pass", False, "hidden test file missing"))

    # 2. Run public tests
    pub_ok, pub_out = _run(workdir, "-m", "pytest", "-q", "tests")
    checks.append(("public tests pass", pub_ok, pub_out))

    # 3. Scope verification: only src/shipping.py changed
    changed = _changed_files(workdir)
    scope_ok = changed == {"src/shipping.py"}
    checks.append(("only src/shipping.py changed", scope_ok, str(sorted(changed))))

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

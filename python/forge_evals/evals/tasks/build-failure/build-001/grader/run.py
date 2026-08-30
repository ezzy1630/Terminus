"""Behavioral grader for the build-failure fixture."""

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
        timeout=20,
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
    import_ok, import_output = _run(workdir, "-c", "import src.main")
    checks.append(("src.main imports cleanly", import_ok, import_output))
    entrypoint_ok, entrypoint_output = _run(workdir, "-m", "src.main")
    checks.append(("the command entry point executes", entrypoint_ok, entrypoint_output))
    tests_ok, tests_output = _run(workdir, "-m", "pytest", "-q")
    checks.append(("regression tests pass", tests_ok, tests_output))
    changed = _changed_files(workdir)
    checks.append(("only the requested source file changed", changed <= {"src/main.py"}, str(sorted(changed))))
    passed = sum(ok for _, ok, _ in checks)
    evidence = [f"passed {passed}/{len(checks)} behavioral checks"]
    evidence.extend(
        f"{name}: {'PASS' if ok else 'FAIL'} {detail}" for name, ok, detail in checks
    )
    result = {
        "passed": passed == len(checks),
        "score": passed / len(checks),
        "evidence": evidence,
        "metadata": {"checks_total": len(checks), "checks_passed": passed},
    }
    print(json.dumps(result))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

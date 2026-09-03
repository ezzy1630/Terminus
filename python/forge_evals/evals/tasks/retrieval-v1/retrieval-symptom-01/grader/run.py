"""Deterministic grader for retrieval-v1/retrieval-symptom-01.

Verifies:
1. DISCOVERY.json correctly identifies src/payments.py, charge_with_retry, and non-empty root_cause
2. Hidden retry tests pass (run first to prevent tampering)
3. Public tests pass (returncode == 0)
4. Scope: only src/payments.py and DISCOVERY.json changed
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

    # 1. Inspect DISCOVERY.json
    discovery_file = workdir / "DISCOVERY.json"
    discovery_ok = False
    discovery_msg = "missing DISCOVERY.json"
    if discovery_file.exists():
        try:
            with open(discovery_file, encoding="utf-8") as f:
                data = json.load(f)
            offending = str(data.get("offending_file", "")).strip().lstrip("./")
            func = str(data.get("function_name", "")).strip()
            root_cause = str(data.get("root_cause", "")).strip()
            if offending == "src/payments.py" and func == "charge_with_retry" and len(root_cause) >= 5:
                discovery_ok = True
                discovery_msg = f"valid discovery: {offending} -> {func} (root cause: {root_cause[:40]}...)"
            else:
                discovery_msg = (
                    f"mismatched discovery fields: offending={offending}, func={func}, "
                    f"root_cause_len={len(root_cause)}"
                )
        except Exception as e:
            discovery_msg = f"failed to parse DISCOVERY.json: {e}"
    checks.append(("DISCOVERY.json valid", discovery_ok, discovery_msg))

    # 2. Run hidden tests first to prevent candidate code tampering
    hidden_test = workdir / "hidden" / "test_hidden.py"
    if hidden_test.exists():
        hidden_ok, hidden_out = _run(workdir, "-m", "pytest", "-q", str(hidden_test))
        checks.append(("hidden retry tests pass", hidden_ok, hidden_out))
    else:
        checks.append(("hidden retry tests pass", False, "hidden test file missing"))

    # 3. Run public tests
    pub_ok, pub_out = _run(workdir, "-m", "pytest", "-q", "tests")
    checks.append(("public tests pass", pub_ok, pub_out))

    # 4. Scope verification
    changed = _changed_files(workdir)
    allowed_changed = {"src/payments.py", "DISCOVERY.json"}
    scope_ok = changed.issubset(allowed_changed) and "src/payments.py" in changed
    checks.append(("scope enforcement (only payments.py and DISCOVERY.json)", scope_ok, str(sorted(changed))))

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

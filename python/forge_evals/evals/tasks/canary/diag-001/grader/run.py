"""Deterministic grader for canary/diag-001 (read-only diagnosis).

Success is decided entirely by repository state:
  1. DIAGNOSIS.md exists and names the module, function, and defective
     expression (the seeded root cause);
  2. no tracked file other than DIAGNOSIS.md changed.

There is no LLM judge on the success path.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REQUIRED_SPANS = [
    ("module path", "src/ledger.py"),
    ("function name", "process_records"),
    ("defective expression", "records[1:]"),
]


def _git_changed(workdir: Path) -> set[str]:
    result = subprocess.run(  # skipcq: BAN-B607
        ["git", "status", "--porcelain"],
        cwd=workdir,
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    if result.returncode != 0:
        return {"<git-status-failed>"}
    return {
        line[3:].strip()
        for line in result.stdout.splitlines()
        if len(line) >= 3 and not line[3:].strip().startswith("hidden/")
    }


def main() -> int:
    payload = json.load(sys.stdin)
    workdir = Path(payload["workdir"]).resolve()
    checks: list[tuple[str, bool, str]] = []

    diagnosis = workdir / "DIAGNOSIS.md"
    if not diagnosis.is_file():
        checks.append(("DIAGNOSIS.md exists", False, "missing"))
    else:
        checks.append(("DIAGNOSIS.md exists", True, ""))
        text = diagnosis.read_text(encoding="utf-8").lower()
        for label, span in REQUIRED_SPANS:
            checks.append((f"names the {label}", span.lower() in text, span))

    changed = _git_changed(workdir)
    checks.append(
        ("only DIAGNOSIS.md changed", changed <= {"DIAGNOSIS.md"}, str(sorted(changed)))
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

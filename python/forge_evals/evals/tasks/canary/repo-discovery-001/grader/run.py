"""Deterministic grader for canary/repo-discovery-001.

Success = DISCOVERY.json states the exact ground-truth discovery facts and no
tracked file changed. Repository-state only; no LLM judge on the success path.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

GROUND_TRUTH = {
    "module_path": "billing/src/charges.py",
    "entry_symbol": "charge_with_retry",
    "retry_count": 3,
    # The mechanism, accepted in a few exact phrasings so the check stays
    # deterministic while not being a pure string match on the prompt.
    "root_cause_accept": ["idempotency key", "idempotency", "idempotent"],
}


def _git_changed(workdir: Path) -> set[str]:
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

    discovery = workdir / "DISCOVERY.json"
    if not discovery.is_file():
        checks.append(("DISCOVERY.json exists", False, "missing"))
        result = {
            "passed": False,
            "score": 0.0,
            "evidence": [f"{name}: {'PASS' if ok else 'FAIL'} {detail}" for name, ok, detail in checks],
            "metadata": {"checks_total": len(checks), "checks_passed": 0},
        }
        print(json.dumps(result))
        return 1

    checks.append(("DISCOVERY.json exists", True, ""))
    try:
        facts = json.loads(discovery.read_text(encoding="utf-8"))
        if not isinstance(facts, dict):
            raise ValueError("not an object")
    except (ValueError, OSError) as error:
        checks.append(("DISCOVERY.json parses to an object", False, str(error)[:200]))
        facts = None
    else:
        checks.append(("DISCOVERY.json parses to an object", True, ""))

    if facts is not None:
        checks.append(
            ("module_path is the charge site", facts.get("module_path") == GROUND_TRUTH["module_path"], str(facts.get("module_path")))
        )
        checks.append(
            ("entry_symbol is the retrying charge function", facts.get("entry_symbol") == GROUND_TRUTH["entry_symbol"], str(facts.get("entry_symbol")))
        )
        checks.append(
            ("retry_count counts every attempt", facts.get("retry_count") == GROUND_TRUTH["retry_count"], str(facts.get("retry_count")))
        )
        cause = str(facts.get("root_cause", "")).lower()
        cause_ok = any(phrase in cause for phrase in GROUND_TRUTH["root_cause_accept"])
        checks.append(("root_cause names the missing idempotency guard", cause_ok, cause[:120]))

    changed = _git_changed(workdir)
    checks.append(("only DISCOVERY.json changed", changed <= {"DISCOVERY.json"}, str(sorted(changed))))

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

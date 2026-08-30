"""Behavioral grader for the cross-file retry feature."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


def main() -> int:
    payload = json.load(sys.stdin)
    workdir = Path(payload["workdir"]).resolve()
    script = r'''
import inspect
from src.api import API
from src.cli import show_user
from src.client import Client
from src.scheduler import refresh

signature = inspect.signature(Client.request)
retry = signature.parameters.get("retry")
assert retry is not None and retry.default == 0

calls = []
client = Client()
client.request = lambda path, payload=None, **kwargs: calls.append((path, kwargs)) or {"path": path}
API(client).list_users()
show_user(client, "7")
refresh(client)
assert calls == [("/users", {"retry": 3}), ("/users/7", {"retry": 3}), ("/refresh", {"retry": 3})]
'''
    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=workdir,
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    output = (result.stdout + result.stderr).strip()[-1_500:]
    checks = [("signature and callers preserve behavior", result.returncode == 0, output)]
    passed = sum(ok for _, ok, _ in checks)
    result_payload = {
        "passed": passed == len(checks),
        "score": passed / len(checks),
        "evidence": [
            f"passed {passed}/{len(checks)} behavioral checks",
            *[f"{name}: {'PASS' if ok else 'FAIL'} {detail}" for name, ok, detail in checks],
        ],
        "metadata": {"checks_total": len(checks), "checks_passed": passed},
    }
    print(json.dumps(result_payload))
    return 0 if result_payload["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

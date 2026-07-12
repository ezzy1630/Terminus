#!/usr/bin/env python3
"""Grader for security-sensitive/01-add-auth-check."""
from __future__ import annotations

import os
import pathlib
import subprocess
import sys


def fail(msg: str) -> None:
    print(f"FAIL: {msg}", file=sys.stderr)
    sys.exit(1)


def main() -> None:
    root = pathlib.Path.cwd()
    api_path = root / "src" / "api.py"
    if not api_path.exists():
        fail("src/api.py does not exist")

    text = api_path.read_text()
    # The agent must use a constant-time comparison.
    if "compare_digest" not in text:
        fail("expected secrets.compare_digest or hmac.compare_digest")
    # The agent must not hardcode the token.
    token = os.environ.get("FORGE_TEST_AUTH_TOKEN", "forge-test-token-do-not-hardcode")
    if token in text:
        fail("auth token literal hardcoded in src/api.py")

    # Public tests.
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "test_api.py"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        fail(f"public tests failed:\n{result.stdout}\n{result.stderr}")

    # Hidden tests.
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "hidden/test_security.py"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        fail(f"hidden tests failed:\n{result.stdout}\n{result.stderr}")

    print("PASS")
    sys.exit(0)


if __name__ == "__main__":
    main()

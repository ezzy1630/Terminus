#!/usr/bin/env python3
"""Grader for the tiny-bugfix/02-null-check task."""
from __future__ import annotations

import pathlib
import subprocess
import sys


def fail(msg: str) -> None:
    print(f"FAIL: {msg}", file=sys.stderr)
    sys.exit(1)


def main() -> None:
    root = pathlib.Path.cwd()
    parser_path = root / "src" / "parser.py"
    if not parser_path.exists():
        fail("src/parser.py does not exist")

    # The signature must not change.
    text = parser_path.read_text()
    if "def parse_user(data):" not in text and "def parse_user(data) ->" not in text:
        fail("parse_user signature changed; expected `def parse_user(data):`")

    # Public tests must still pass.
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "test_parser.py"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        fail(f"public tests failed:\n{result.stdout}\n{result.stderr}")

    # Hidden tests must pass.
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "hidden/test_fix.py"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        fail(f"hidden tests failed:\n{result.stdout}\n{result.stderr}")

    print("PASS")
    sys.exit(0)


if __name__ == "__main__":
    main()

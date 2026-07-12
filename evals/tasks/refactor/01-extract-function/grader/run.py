#!/usr/bin/env python3
"""Grader for refactor/01-extract-function."""
from __future__ import annotations

import ast
import pathlib
import subprocess
import sys


def fail(msg: str) -> None:
    print(f"FAIL: {msg}", file=sys.stderr)
    sys.exit(1)


def main() -> None:
    root = pathlib.Path.cwd()
    fmt_path = root / "src" / "format.py"
    if not fmt_path.exists():
        fail("src/format.py does not exist")

    text = fmt_path.read_text()
    tree = ast.parse(text)
    funcs = {n.name for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)}
    if "format_price" not in funcs:
        fail("format_price function not found in src/format.py")
    if "format_invoice" not in funcs:
        fail("format_invoice function missing or renamed")

    # Public tests pass.
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "test_format.py"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        fail(f"public tests failed:\n{result.stdout}\n{result.stderr}")

    # Hidden tests pass.
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "hidden/test_refactor.py"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        fail(f"hidden tests failed:\n{result.stdout}\n{result.stderr}")

    print("PASS")
    sys.exit(0)


if __name__ == "__main__":
    main()

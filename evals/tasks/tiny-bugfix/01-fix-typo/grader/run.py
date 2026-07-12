#!/usr/bin/env python3
"""Grader for the tiny-bugfix/01-fix-typo task.

Run by the eval harness AFTER the agent declares the task complete.
Checks:
  1. The agent did not modify any file other than src/lib.py.
  2. The word 'recieve' no longer appears in src/lib.py.
  3. The word 'receive' (or 'receives') appears in src/lib.py.
  4. The hidden test (hidden/test_fix.py) passes.
  5. The public test (test_lib.py) still passes.

Exit code 0 = PASS, non-zero = FAIL.
"""
from __future__ import annotations

import pathlib
import subprocess
import sys


def fail(msg: str) -> None:
    print(f"FAIL: {msg}", file=sys.stderr)
    sys.exit(1)


def main() -> None:
    root = pathlib.Path.cwd()

    # 1. Only src/lib.py may have changed. The grader is given the baseline
    #    file list via the eval harness; for this fixture we check that no
    #    other source files exist that the agent might have created.
    allowed = {root / "src" / "lib.py"}
    extra_source_files = [
        p for p in root.rglob("*.py")
        if p not in allowed
        and "hidden" not in p.parts
        and p.name != "test_lib.py"
        and "__pycache__" not in p.parts
    ]
    if extra_source_files:
        fail(f"unexpected source files created: {[str(p) for p in extra_source_files]}")

    lib_path = root / "src" / "lib.py"
    if not lib_path.exists():
        fail("src/lib.py does not exist")
    text = lib_path.read_text()

    # 2. The typo is gone.
    if "recieve" in text:
        fail("typo 'recieve' still present in src/lib.py")

    # 3. The correct spelling appears.
    import re
    if not re.search(r"receives?\b", text):
        fail("no correct spelling 'receive' found in src/lib.py")

    # 4. Hidden test passes.
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "hidden/test_fix.py"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        fail(f"hidden test failed:\n{result.stdout}\n{result.stderr}")

    # 5. Public test still passes.
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "test_lib.py"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        fail(f"public test failed:\n{result.stdout}\n{result.stderr}")

    print("PASS")
    sys.exit(0)


if __name__ == "__main__":
    main()

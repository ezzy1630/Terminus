#!/usr/bin/env bash
# Setup script for the tiny-bugfix/01-fix-typo task.
# Runs in the eval sandbox BEFORE the agent starts.
set -euo pipefail

mkdir -p src
cat > src/lib.py <<'PY'
"""Tiny library with a typo."""

def greet(name: str) -> str:
    """Return a greeting.

    The function recieves a name and returns a greeting string.
    """
    return f"Hello, {name}!"


def main() -> None:
    print(greet("world"))


if __name__ == "__main__":
    main()
PY

cat > test_lib.py <<'PY'
from src.lib import greet


def test_greet():
    assert greet("world") == "Hello, world!"
    assert greet("recieve") == "Hello, recieve!"


def test_typo_not_present():
    # The function docstring should not contain the misspelling after the fix.
    import src.lib as lib
    assert "recieve" not in lib.greet.__doc__
    assert "receive" in lib.greet.__doc__
PY

mkdir -p hidden
cat > hidden/test_fix.py <<'PY'
# Hidden tests — never projected to model context. Run by the grader.
import pathlib
import re

def test_typo_fixed_in_source():
    text = pathlib.Path("src/lib.py").read_text()
    assert "recieve" not in text, "typo 'recieve' still present in src/lib.py"
    # Allow either 'receive' or 'receives' (both correct spellings).
    assert re.search(r"receives?\b", text), "no correct spelling 'receive' found"
PY

echo "setup complete"

#!/bin/bash
set -euo pipefail
mkdir -p src tests
cat > .gitignore <<'EOF'
__pycache__/
.pytest_cache/
EOF
mkdir -p hidden
cp "$TERMINUS_TASK_DIR/hidden/test_hidden.py" hidden/test_hidden.py
touch src/__init__.py
cat > src/main.py <<'PY'
"""Small command entry point with an import-time build failure."""

from .runner import run


def main(argv: list[str] | None = None) -> int:
    """Run the command and return its process status."""
    if argv is None:
        argv = []
    return run(argv)


if __name__ == "__main__":
    sys.exit(main())
PY
cat > src/runner.py <<'PY'
"""Command implementation."""


def run(argv: list[str]) -> int:
    """Return success for the intentionally tiny command."""
    return 0 if not argv or argv[0] != "--fail" else 1
PY
cat > tests/test_main.py <<'PY'
from src.main import main


def test_main_returns_success_without_arguments() -> None:
    assert main([]) == 0


def test_main_returns_failure_for_fail_flag() -> None:
    assert main(["--fail"]) == 1
PY

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
cat > src/parser.py <<'PY'
"""Token parser whose boundary behavior is part of the public contract."""


def parse_tokens(text: str) -> list[str]:
    """Split text into non-empty whitespace-delimited tokens."""
    return text.split()
PY
cat > tests/test_parser_existing.py <<'PY'
from src.parser import parse_tokens


def test_parser_handles_normal_input() -> None:
    assert parse_tokens("alpha beta") == ["alpha", "beta"]
PY

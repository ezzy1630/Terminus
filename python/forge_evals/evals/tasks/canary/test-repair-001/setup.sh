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
cat > src/textops.py <<'PY'
"""Text utilities with a seeded defect against the failing suite."""

import re
import unicodedata


def slugify(text: str) -> str:
    """Return a URL-safe slug for ``text``.

    Intended behavior (per tests/test_slugify.py): lowercase, strip accents
    to ASCII, replace every run of non-alphanumeric characters with a single
    hyphen, and strip leading/trailing hyphens. The implementation below
    never strips accents and does not collapse separator runs.
    """
    lowered = text.lower()
    slug = re.sub(r"[^a-z0-9]+", "-", lowered)
    return slug.strip("-")
PY
cat > tests/test_slugify.py <<'PY'
from src.textops import slugify


def test_plain_words():
    assert slugify("Hello World") == "hello-world"


def test_accents_are_stripped_to_ascii():
    assert slugify("Héllo Wörld") == "hello-world"


def test_punctuation_runs_collapse_to_one_hyphen():
    assert slugify("Hello,   World!!") == "hello-world"


def test_leading_and_trailing_separators_are_stripped():
    assert slugify("  --Hello World--  ") == "hello-world"
PY
cat > justfile <<'JUST'
test:
    python3 -m pytest -q
JUST

#!/usr/bin/env bash
# Setup script for the tiny-bugfix/02-null-check task.
set -euo pipefail

mkdir -p src
cat > src/parser.py <<'PY'
"""User parser that does not handle None."""


def parse_user(data):
    """Parse a user dict into a (name, age) tuple.

    Raises AttributeError when data is None or missing the 'name' key.
    """
    name = data["name"]
    age = data.get("age", 0)
    return (name, age)
PY

cat > test_parser.py <<'PY'
from src.parser import parse_user


def test_parse_user_with_full_data():
    assert parse_user({"name": "Alice", "age": 30}) == ("Alice", 30)


def test_parse_user_without_age():
    assert parse_user({"name": "Bob"}) == ("Bob", 0)
PY

mkdir -p hidden
cat > hidden/test_fix.py <<'PY'
# Hidden tests — never projected to model context.
from src.parser import parse_user


def test_parse_user_none():
    assert parse_user(None) is None


def test_parse_user_missing_name():
    assert parse_user({"age": 30}) is None


def test_parse_user_empty_dict():
    assert parse_user({}) is None
PY

echo "setup complete"

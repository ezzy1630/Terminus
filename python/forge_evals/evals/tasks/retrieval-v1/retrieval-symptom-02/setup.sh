#!/bin/bash
set -euo pipefail

mkdir -p src tests hidden
cat > .gitignore <<'EOF'
__pycache__/
.pytest_cache/
EOF

touch src/__init__.py

cat > src/server.py <<'PY'
"""API server routes for inventory ingestion."""

def handle_upload_request(payload: str):
    return {"status": "received", "bytes": len(payload)}
PY

cat > src/database.py <<'PY'
"""Database storage for inventory items."""

def upsert_item(item_id: int, quantity: int):
    return True
PY

cat > src/exporter.py <<'PY'
"""Data export routines."""

def export_csv(rows: list):
    return "\n".join(",".join(map(str, r)) for r in rows)
PY

cat > src/batch_parser.py <<'PY'
"""Batch input parser for comma-separated integer pairs."""

from typing import List, Dict


def parse_batch_items(raw_text: str) -> List[Dict[str, int]]:
    """Parse lines of item_id, quantity into structured dictionaries.

    DEFECT: Iterates raw lines directly. When lines are blank or contain
    comments, int(parts[0]) throws ValueError: invalid literal for int() with base 10: ''.
    """
    results = []
    lines = raw_text.splitlines()
    for line in lines:
        # Seeded defect: fails to strip whitespace, skip empty lines, or skip # comments
        parts = line.split(",")
        item_id = int(parts[0])
        quantity = int(parts[1])
        results.append({"item_id": item_id, "quantity": quantity})
    return results
PY

cat > tests/test_batch_parser.py <<'PY'
from src.batch_parser import parse_batch_items


def test_clean_input():
    data = "1,10\n2,20\n3,30"
    items = parse_batch_items(data)
    assert len(items) == 3
    assert items[0] == {"item_id": 1, "quantity": 10}
PY

cat > justfile <<'JUST'
test:
    python3 -m pytest -q
JUST

if [ -f "$TERMINUS_TASK_DIR/hidden/test_hidden.py" ]; then
  cp "$TERMINUS_TASK_DIR/hidden/test_hidden.py" hidden/test_hidden.py
fi
